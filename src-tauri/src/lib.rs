use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use reqwest::Url;
use semver::Version;
use tauri::path::BaseDirectory;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const BACKEND_EXE_NAME: &str = if cfg!(target_os = "windows") {
    "radar_backend.exe"
} else {
    "radar_backend"
};
const S3_LEVEL3_LIST_URL: &str = "https://unidata-nexrad-level3.s3.amazonaws.com/";
const TGFTP_LEVEL3_BASE_URL: &str = "https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar";
const DECODE_CACHE_VERSION: u32 = 1;
const DECODE_CACHE_MAX_FILES: usize = 384;
const DECODE_CACHE_MAX_BYTES: u64 = 768 * 1024 * 1024;
const DECODE_CACHE_MAX_AGE_SECS: u64 = 3 * 24 * 60 * 60;
const DECODE_CACHE_CLEANUP_INTERVAL_WRITES: usize = 8;
static DECODE_CACHE_WRITE_COUNT: AtomicUsize = AtomicUsize::new(0);

struct BackendInner {
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    _child: Child,
}

enum BackendState {
    Ready(BackendInner),
    Failed(String),
}

// Default number of Python backend processes to spawn. Each process handles one
// decode at a time; additional workers increase parallelism but also RAM usage.
const DEFAULT_BACKEND_POOL_SIZE: usize = 1;
const BACKEND_LAZY_INIT_MESSAGE: &str = "Backend not started yet (lazy init)";
const APP_UPDATE_CHECK_TIMEOUT_SECS: u64 = 10;

fn backend_pool_size() -> usize {
    std::env::var("RADAR_BACKEND_POOL_SIZE")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .map(|n| n.clamp(1, 4))
        .unwrap_or(DEFAULT_BACKEND_POOL_SIZE)
}

struct Backend(Arc<Vec<Mutex<BackendState>>>);

#[derive(Default)]
struct NwwsBridgeState {
    child: Mutex<Option<Child>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    current_version: String,
    body: Option<String>,
    date: Option<String>,
    download_url: String,
    release_url: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResponse {
    status: String,
    current_version: String,
    update: Option<UpdateInfo>,
    message: Option<String>,
}

#[derive(serde::Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(serde::Deserialize)]
struct GitHubLatestRelease {
    tag_name: String,
    body: Option<String>,
    html_url: String,
    published_at: Option<String>,
    assets: Vec<GitHubReleaseAsset>,
}

fn terminate_child_process(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id();
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn stop_nwws_bridge_process(child_slot: &Mutex<Option<Child>>) {
    let mut guard = child_slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut child) = guard.take() {
        terminate_child_process(&mut child);
    }
}

fn stop_nwws_bridge_process_for_app(app: &AppHandle) {
    if let Some(state) = app.try_state::<NwwsBridgeState>() {
        stop_nwws_bridge_process(&state.child);
    }
}

impl Drop for NwwsBridgeState {
    fn drop(&mut self) {
        stop_nwws_bridge_process(&self.child);
    }
}

/// Grab any idle backend from the pool without blocking. Falls back to blocking
/// on pool[0] when all workers are busy.
fn acquire_backend(pool: &[Mutex<BackendState>]) -> std::sync::MutexGuard<'_, BackendState> {
    for mutex in pool {
        if let Ok(guard) = mutex.try_lock() {
            return guard;
        }
    }
    // All busy — wait for the first one to free up
    pool[0].lock().unwrap_or_else(|e| e.into_inner())
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn backend_candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            push_unique(&mut paths, exe_dir.join(BACKEND_EXE_NAME));
            push_unique(
                &mut paths,
                exe_dir.join("resources").join(BACKEND_EXE_NAME),
            );
            push_unique(
                &mut paths,
                exe_dir.join("Resources").join(BACKEND_EXE_NAME),
            );

            if let Some(parent) = exe_dir.parent() {
                push_unique(
                    &mut paths,
                    parent.join("binaries").join(BACKEND_EXE_NAME),
                );
            }

            if let Some(src_tauri_dir) = exe_dir.parent().and_then(|p| p.parent()) {
                push_unique(
                    &mut paths,
                    src_tauri_dir.join("binaries").join(BACKEND_EXE_NAME),
                );
            }
        }
    }

    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let manifest_dir = PathBuf::from(manifest_dir);
        push_unique(
            &mut paths,
            manifest_dir.join("binaries").join(BACKEND_EXE_NAME),
        );
    }

    push_unique(
        &mut paths,
        PathBuf::from("src-tauri")
            .join("binaries")
            .join(BACKEND_EXE_NAME),
    );
    push_unique(&mut paths, PathBuf::from("binaries").join(BACKEND_EXE_NAME));

    paths
}

fn backend_script_candidate_paths() -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from("backend").join("server.py"),
        PathBuf::from("..").join("backend").join("server.py"),
    ];

    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let manifest_dir = PathBuf::from(manifest_dir);
        push_unique(
            &mut paths,
            manifest_dir.join("..").join("backend").join("server.py"),
        );
    }

    paths
}

fn newest_existing_path(paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths
        .into_iter()
        .filter(|p| p.is_file())
        .max_by_key(|p| {
            p.metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH)
        })
}

fn normalize_release_endpoint(raw: &str) -> Option<String> {
    raw.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .filter(|line| line.starts_with("https://"))
}

fn resolve_release_endpoint(app: &AppHandle) -> Option<String> {
    if let Ok(value) = std::env::var("RADAR_RELEASE_ENDPOINT") {
        if let Some(endpoint) = normalize_release_endpoint(&value) {
            return Some(endpoint);
        }
    }

    if let Ok(value) = std::env::var("RADAR_UPDATER_ENDPOINT") {
        if let Some(endpoint) = normalize_release_endpoint(&value) {
            return Some(endpoint);
        }
    }

    if let Ok(path) = app.path().resolve("updater-endpoint.txt", BaseDirectory::Resource) {
        if let Ok(contents) = fs::read_to_string(path) {
            if let Some(endpoint) = normalize_release_endpoint(&contents) {
                return Some(endpoint);
            }
        }
    }

    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let path = PathBuf::from(manifest_dir).join("updater-endpoint.txt");
        if let Ok(contents) = fs::read_to_string(path) {
            if let Some(endpoint) = normalize_release_endpoint(&contents) {
                return Some(endpoint);
            }
        }
    }

    None
}

fn release_version_label(raw: &str) -> String {
    raw.trim()
        .strip_prefix('v')
        .unwrap_or(raw.trim())
        .trim()
        .to_string()
}

fn parse_release_version(raw: &str) -> Result<Version, String> {
    Version::parse(&release_version_label(raw))
        .map_err(|err| format!("Release tag `{raw}` is not valid semver: {err}"))
}

fn pick_release_download_url(release: &GitHubLatestRelease) -> String {
    release
        .assets
        .iter()
        .min_by_key(|asset| {
            let name = asset.name.to_ascii_lowercase();
            if name.ends_with("-setup.exe") {
                0u8
            } else if name.ends_with(".msi") {
                1u8
            } else if name.ends_with(".exe") {
                2u8
            } else {
                3u8
            }
        })
        .map(|asset| asset.browser_download_url.clone())
        .unwrap_or_else(|| release.html_url.clone())
}

fn command_exists(program: &str) -> bool {
    let mut cmd = Command::new(program);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.status().is_ok()
}

fn find_python_command() -> Option<(OsString, Vec<OsString>)> {
    if cfg!(target_os = "windows") {
        if command_exists("py") {
            return Some((
                OsString::from("py"),
                vec![OsString::from("-3"), OsString::from("-u")],
            ));
        }
        if command_exists("python") {
            return Some((OsString::from("python"), vec![OsString::from("-u")]));
        }
    } else {
        if command_exists("python3") {
            return Some((OsString::from("python3"), vec![OsString::from("-u")]));
        }
        if command_exists("python") {
            return Some((OsString::from("python"), vec![OsString::from("-u")]));
        }
    }

    None
}

fn spawn_backend_process(
    program: OsString,
    args: Vec<OsString>,
    source_label: &str,
) -> Result<BackendInner, String> {
    let mut cmd = Command::new(&program);
    // Favor lower memory defaults in single-backend mode; callers can override
    // any of these via environment variables.
    let l2_bytes_cache = std::env::var("RADAR_L2_BYTES_CACHE_MAX")
        .unwrap_or_else(|_| String::from("1"));
    let l2_chunk_cache = std::env::var("RADAR_L2_CHUNK_CACHE_MAX")
        .unwrap_or_else(|_| String::from("1"));
    let l2_chunk_workers = std::env::var("RADAR_L2_CHUNK_FETCH_WORKERS")
        .unwrap_or_else(|_| String::from("4"));
    let l2_parsed_cache = std::env::var("RADAR_L2_PARSED_CACHE_MAX")
        .unwrap_or_else(|_| String::from("1"));
    let l2_sweep_geom_cache = std::env::var("RADAR_L2_SWEEP_GEOM_MAX")
        .unwrap_or_else(|_| String::from("1"));
    let l3_render_cache = std::env::var("RADAR_L3_RENDER_CACHE_MAX")
        .unwrap_or_else(|_| String::from("4"));
    let local_parsed_cache = std::env::var("RADAR_LOCAL_PARSED_CACHE_MAX")
        .unwrap_or_else(|_| String::from("1"));
    let local_render_cache = std::env::var("RADAR_LOCAL_RENDER_CACHE_MAX")
        .unwrap_or_else(|_| String::from("4"));
    let max_gates = std::env::var("RADAR_MAX_GATES")
        .unwrap_or_else(|_| String::from("750000"));
    let max_gates_vel = std::env::var("RADAR_MAX_GATES_VEL")
        .unwrap_or_else(|_| String::from("1500000"));
    cmd.args(&args)
        .env("OMP_NUM_THREADS", std::env::var("OMP_NUM_THREADS").unwrap_or_else(|_| String::from("1")))
        .env("OPENBLAS_NUM_THREADS", std::env::var("OPENBLAS_NUM_THREADS").unwrap_or_else(|_| String::from("1")))
        .env("MKL_NUM_THREADS", std::env::var("MKL_NUM_THREADS").unwrap_or_else(|_| String::from("1")))
        .env("NUMEXPR_NUM_THREADS", std::env::var("NUMEXPR_NUM_THREADS").unwrap_or_else(|_| String::from("1")))
        .env("RADAR_L2_BYTES_CACHE_MAX", l2_bytes_cache)
        .env("RADAR_L2_CHUNK_CACHE_MAX", l2_chunk_cache)
        .env("RADAR_L2_CHUNK_FETCH_WORKERS", l2_chunk_workers)
        .env("RADAR_L2_PARSED_CACHE_MAX", l2_parsed_cache)
        .env("RADAR_L2_SWEEP_GEOM_MAX", l2_sweep_geom_cache)
        .env("RADAR_L3_RENDER_CACHE_MAX", l3_render_cache)
        .env("RADAR_LOCAL_PARSED_CACHE_MAX", local_parsed_cache)
        .env("RADAR_LOCAL_RENDER_CACHE_MAX", local_render_cache)
        .env("RADAR_MAX_GATES", max_gates)
        .env("RADAR_MAX_GATES_VEL", max_gates_vel)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not spawn backend from {source_label}: {e}"))?;

    let stdin = child.stdin.take().ok_or("Backend stdin pipe missing")?;
    let stdout = child.stdout.take().ok_or("Backend stdout pipe missing")?;

    Ok(BackendInner {
        stdin: BufWriter::new(stdin),
        stdout: BufReader::new(stdout),
        _child: child,
    })
}

fn spawn_backend() -> Result<BackendInner, String> {
    let script_path = newest_existing_path(backend_script_candidate_paths());
    let exe_path = newest_existing_path(backend_candidate_paths());

    let mut attempts = Vec::new();

    let try_script = |path: &PathBuf| -> Result<BackendInner, String> {
        if let Some((program, mut args)) = find_python_command() {
            args.push(path.clone().into_os_string());
            return spawn_backend_process(
                program,
                args,
                &format!("python script {}", path.display()),
            );
        }

        Err(format!(
            "Found backend script at {}, but no Python interpreter was found (tried py, python, python3).",
            path.display()
        ))
    };

    let try_exe = |path: &PathBuf| -> Result<BackendInner, String> {
        spawn_backend_process(
            path.clone().into_os_string(),
            vec![],
            &format!("binary {}", path.display()),
        )
    };

    // In dev we prefer the Python script so code changes apply immediately.
    if cfg!(debug_assertions) {
        if let Some(path) = &script_path {
            match try_script(path) {
                Ok(inner) => return Ok(inner),
                Err(err) => attempts.push(err),
            }
        }
        if let Some(path) = &exe_path {
            match try_exe(path) {
                Ok(inner) => return Ok(inner),
                Err(err) => attempts.push(err),
            }
        }
    } else {
        if let Some(path) = &exe_path {
            match try_exe(path) {
                Ok(inner) => return Ok(inner),
                Err(err) => attempts.push(err),
            }
        }
        if let Some(path) = &script_path {
            match try_script(path) {
                Ok(inner) => return Ok(inner),
                Err(err) => attempts.push(err),
            }
        }
    }

    let checked = backend_candidate_paths()
        .into_iter()
        .map(|p| format!("  - {}", p.display()))
        .collect::<Vec<_>>()
        .join("\n");

    let mut msg = format!(
        "Could not start radar backend.\nChecked binary paths:\n{}",
        checked
    );
    if !attempts.is_empty() {
        msg.push_str("\nStartup errors:");
        for err in attempts {
            msg.push_str(&format!("\n  - {}", err));
        }
    }
    msg.push_str("\nBuild backend binary with backend/build.bat if needed.");

    Err(msg)
}

fn request_backend(inner: &mut BackendInner, req_obj: serde_json::Value) -> Result<serde_json::Value, String> {
    let req = req_obj.to_string();
    writeln!(inner.stdin, "{req}").map_err(|e| e.to_string())?;
    inner.stdin.flush().map_err(|e| e.to_string())?;

    let val: serde_json::Value = loop {
        let mut line = String::with_capacity(256 * 1024);
        let bytes_read = inner
            .stdout
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        if bytes_read == 0 {
            return Err("Backend closed unexpectedly".into());
        }

        let trimmed = line.trim();
        if !trimmed.starts_with('{') {
            continue;
        }

        break serde_json::from_str(trimmed).map_err(|e| format!("Backend parse error: {e}"))?;
    };

    if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    Ok(val)
}

fn read_binary_response(inner: &mut BackendInner) -> Result<Vec<u8>, String> {
    let mut len_buf = [0u8; 4];
    inner.stdout.read_exact(&mut len_buf).map_err(|e| e.to_string())?;
    let len = u32::from_le_bytes(len_buf) as usize;
    let mut blob = vec![0u8; len];
    inner.stdout.read_exact(&mut blob).map_err(|e| e.to_string())?;
    // If the payload starts with '{', it's a JSON error from the backend.
    if blob.starts_with(b"{") {
        let val: serde_json::Value = serde_json::from_slice(&blob)
            .unwrap_or_else(|_| serde_json::json!({"error": String::from_utf8_lossy(&blob).to_string()}));
        return Err(val.get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown backend error")
            .to_string());
    }
    Ok(blob)
}

fn request_decode_binary(inner: &mut BackendInner, req_obj: serde_json::Value) -> Result<Vec<u8>, String> {
    let req = req_obj.to_string();
    writeln!(inner.stdin, "{req}").map_err(|e| e.to_string())?;
    inner.stdin.flush().map_err(|e| e.to_string())?;
    read_binary_response(inner)
}

fn should_restart_backend(err: &str) -> bool {
    err.contains("os error 232")
        || err.contains("os error 109")
        || err.contains("Broken pipe")
        || err.contains("Backend closed unexpectedly")
}

fn should_retry_after_backend_refresh(err: &str) -> bool {
    should_restart_backend(err) || err.trim() == "'key'"
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearDecodeCacheResponse {
    files_removed: u64,
    bytes_removed: u64,
}

struct CacheFileEntry {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

fn decode_cache_base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Could not resolve app data dir: {err}"))?
        .join("decode-cache"))
}

fn decode_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = decode_cache_base_dir(app)?.join(format!("v{DECODE_CACHE_VERSION}"));
    fs::create_dir_all(&dir).map_err(|err| format!("Could not create decode cache dir: {err}"))?;
    Ok(dir)
}

fn stable_hash64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn decode_cache_signature(kind: &str, signature: &serde_json::Value) -> Result<String, String> {
    let payload = serde_json::to_vec(signature)
        .map_err(|err| format!("Could not serialize decode cache signature: {err}"))?;
    let mut bytes = Vec::with_capacity(kind.len() + 1 + payload.len());
    bytes.extend_from_slice(kind.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(&payload);
    Ok(format!("{:016x}", stable_hash64(&bytes)))
}

fn decode_cache_file_path(
    app: &AppHandle,
    kind: &str,
    signature: &serde_json::Value,
) -> Result<PathBuf, String> {
    let dir = decode_cache_root(app)?.join(kind);
    fs::create_dir_all(&dir).map_err(|err| format!("Could not create decode cache dir: {err}"))?;
    let key = decode_cache_signature(kind, signature)?;
    Ok(dir.join(format!("{key}.rdar")))
}

fn is_valid_decode_blob(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && &bytes[..4] == b"RDAR"
}

fn read_decode_cache_bytes(
    app: &AppHandle,
    kind: &str,
    signature: &serde_json::Value,
) -> Option<Vec<u8>> {
    let path = decode_cache_file_path(app, kind, signature).ok()?;
    let bytes = fs::read(&path).ok()?;
    if is_valid_decode_blob(&bytes) {
        return Some(bytes);
    }
    let _ = fs::remove_file(path);
    None
}

fn collect_cache_files_recursive(dir: &Path, files: &mut Vec<CacheFileEntry>) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|err| format!("Could not read cache dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Could not read cache entry: {err}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|err| format!("Could not inspect cache entry: {err}"))?;
        if file_type.is_dir() {
            collect_cache_files_recursive(&path, files)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let meta = entry
            .metadata()
            .map_err(|err| format!("Could not read cache metadata: {err}"))?;
        files.push(CacheFileEntry {
            path,
            size: meta.len(),
            modified: meta.modified().unwrap_or(UNIX_EPOCH),
        });
    }
    Ok(())
}

fn cleanup_decode_cache(app: &AppHandle) -> Result<(), String> {
    let root = decode_cache_root(app)?;
    let mut files = Vec::new();
    collect_cache_files_recursive(&root, &mut files)?;

    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(DECODE_CACHE_MAX_AGE_SECS))
        .unwrap_or(UNIX_EPOCH);
    let mut retained = Vec::new();
    let mut total_files = 0usize;
    let mut total_bytes = 0u64;

    for entry in files {
        if entry.modified < cutoff {
            let _ = fs::remove_file(&entry.path);
            continue;
        }
        total_files += 1;
        total_bytes = total_bytes.saturating_add(entry.size);
        retained.push(entry);
    }

    if total_files <= DECODE_CACHE_MAX_FILES && total_bytes <= DECODE_CACHE_MAX_BYTES {
        return Ok(());
    }

    retained.sort_by_key(|entry| entry.modified);
    for entry in retained {
        if total_files <= DECODE_CACHE_MAX_FILES && total_bytes <= DECODE_CACHE_MAX_BYTES {
            break;
        }
        let _ = fs::remove_file(&entry.path);
        total_files = total_files.saturating_sub(1);
        total_bytes = total_bytes.saturating_sub(entry.size);
    }

    Ok(())
}

fn write_decode_cache_bytes(
    app: &AppHandle,
    kind: &str,
    signature: &serde_json::Value,
    bytes: &[u8],
) -> Result<(), String> {
    if !is_valid_decode_blob(bytes) {
        return Err("Backend returned invalid decode blob".into());
    }

    let path = decode_cache_file_path(app, kind, signature)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_path = path.with_extension(format!("tmp-{nonce}.rdar"));
    fs::write(&tmp_path, bytes)
        .map_err(|err| format!("Could not write decode cache temp file: {err}"))?;
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&tmp_path, &path).map_err(|err| {
        let _ = fs::remove_file(&tmp_path);
        format!("Could not finalize decode cache file: {err}")
    })?;

    if DECODE_CACHE_WRITE_COUNT.fetch_add(1, Ordering::Relaxed) % DECODE_CACHE_CLEANUP_INTERVAL_WRITES == 0 {
        let _ = cleanup_decode_cache(app);
    }

    Ok(())
}

fn local_file_signature(path: &str) -> serde_json::Value {
    match fs::metadata(path) {
        Ok(meta) => {
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|ts| ts.duration_since(UNIX_EPOCH).ok())
                .map(|dur| dur.as_millis() as u64);
            serde_json::json!({
                "path": path,
                "size": meta.len(),
                "modifiedMs": modified_ms,
            })
        }
        Err(_) => serde_json::json!({
            "path": path,
            "size": 0u64,
            "modifiedMs": serde_json::Value::Null,
        }),
    }
}

fn restart_backend_pool(pool: &Arc<Vec<Mutex<BackendState>>>) -> Result<(), String> {
    let mut failures = Vec::new();
    for backend in pool.iter() {
        let mut guard = backend.lock().unwrap_or_else(|e| e.into_inner());
        if let BackendState::Ready(inner) = &mut *guard {
            terminate_child_process(&mut inner._child);
        }
        match spawn_backend() {
            Ok(inner) => *guard = BackendState::Ready(inner),
            Err(err) => {
                failures.push(err.clone());
                *guard = BackendState::Failed(err);
            }
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Could not restart {} backend worker(s): {}",
            failures.len(),
            failures.join(" | ")
        ))
    }
}

fn clear_decode_cache_dir(app: &AppHandle) -> Result<ClearDecodeCacheResponse, String> {
    let base_dir = decode_cache_base_dir(app)?;
    if !base_dir.exists() {
        return Ok(ClearDecodeCacheResponse {
            files_removed: 0,
            bytes_removed: 0,
        });
    }

    let mut files = Vec::new();
    collect_cache_files_recursive(&base_dir, &mut files)?;
    let files_removed = files.len() as u64;
    let bytes_removed = files
        .iter()
        .fold(0u64, |acc, entry| acc.saturating_add(entry.size));
    fs::remove_dir_all(&base_dir)
        .map_err(|err| format!("Could not delete decode cache dir: {err}"))?;

    Ok(ClearDecodeCacheResponse {
        files_removed,
        bytes_removed,
    })
}

#[derive(serde::Serialize)]
struct L3ListPageResponse {
    keys: Vec<String>,
    next: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct L3ResolvedKeyMeta {
    key: String,
    product: String,
    requested_label: String,
    fallback: bool,
    cross_tilt: bool,
    historical: bool,
    age_days: Option<f64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct L3ResolveSelectionResponse {
    latest: Option<L3ResolvedKeyMeta>,
    history: Vec<L3ResolvedKeyMeta>,
    available_products: Vec<String>,
}

const L3_TILT_VALUES: [&str; 4] = ["0.5", "1.5", "2.4", "3.1"];

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let mut y = y as i64;
    let m = m as i64;
    let d = d as i64;
    y -= if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += if m <= 2 { 1 } else { 0 };
    (y as i32, m as u32, d as u32)
}

fn format_flat_datetime_from_ms(unix_ms: i64) -> String {
    let unix_s = unix_ms.div_euclid(1_000);
    let day = unix_s.div_euclid(86_400);
    let sod = unix_s.rem_euclid(86_400);
    let hour = sod / 3_600;
    let min = (sod % 3_600) / 60;
    let sec = sod % 60;
    let (y, m, d) = civil_from_days(day);
    format!("{y:04}_{m:02}_{d:02}_{hour:02}_{min:02}_{sec:02}")
}

fn flat_date_days_ago(days: f64) -> String {
    let unix_ms = now_unix_ms() - (days * 86_400_000.0) as i64;
    let unix_s = unix_ms.div_euclid(1_000);
    let (y, m, d) = civil_from_days(unix_s.div_euclid(86_400));
    format!("{y:04}_{m:02}_{d:02}")
}

fn flat_datetime_minutes_ago(minutes: i64) -> String {
    format_flat_datetime_from_ms(now_unix_ms() - minutes * 60_000)
}

fn parse_l3_key_timestamp_ms(key: &str) -> Option<i64> {
    if let Some(ts) = key.strip_prefix("TGFTP:").and_then(|rest| rest.split(':').nth(3)) {
        if ts.len() != 15 {
            return None;
        }
        let y: i32 = ts[0..4].parse().ok()?;
        let mo: u32 = ts[4..6].parse().ok()?;
        let d: u32 = ts[6..8].parse().ok()?;
        let h: i64 = ts[9..11].parse().ok()?;
        let mi: i64 = ts[11..13].parse().ok()?;
        let s: i64 = ts[13..15].parse().ok()?;
        if ts.as_bytes().get(8).copied() != Some(b'-') {
            return None;
        }
        if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 59 {
            return None;
        }
        let days = days_from_civil(y, mo, d);
        return Some((days * 86_400 + h * 3_600 + mi * 60 + s) * 1_000);
    }

    let parts: Vec<&str> = key.split('_').collect();
    if parts.len() < 8 {
        return None;
    }
    let n = parts.len();
    let y: i32 = parts[n - 6].parse().ok()?;
    let mo: u32 = parts[n - 5].parse().ok()?;
    let d: u32 = parts[n - 4].parse().ok()?;
    let h: i64 = parts[n - 3].parse().ok()?;
    let mi: i64 = parts[n - 2].parse().ok()?;
    let s: i64 = parts[n - 1].parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    Some((days * 86_400 + h * 3_600 + mi * 60 + s) * 1_000)
}

fn key_age_days(key: &str) -> Option<f64> {
    let ts = parse_l3_key_timestamp_ms(key)?;
    Some((now_unix_ms() - ts) as f64 / 86_400_000.0)
}

fn is_fresh_key(key: &str, max_age_days: f64) -> bool {
    key_age_days(key).is_some_and(|age| age <= max_age_days)
}

fn normalize_tilt(tilt: &str) -> &'static str {
    match tilt {
        "0.5" => "0.5",
        "1.5" => "1.5",
        "2.4" => "2.4",
        "3.1" => "3.1",
        _ => "0.5",
    }
}

fn id3(station_id: &str) -> String {
    if station_id.starts_with('K') && station_id.len() > 1 {
        station_id[1..].to_string()
    } else {
        station_id.to_string()
    }
}

fn selection_label(family: &str, tilt: &str) -> String {
    format!("{} {}°", family.to_ascii_uppercase(), normalize_tilt(tilt))
}

fn family_products_for_tilt(family: &str, tilt: &str) -> Vec<&'static str> {
    let t = normalize_tilt(tilt);
    match family.to_ascii_uppercase().as_str() {
        "REF" => match t {
            "0.5" => vec!["N0B"],
            "1.5" => vec!["N1B", "NAB"],
            "2.4" => vec!["N2B"],
            "3.1" => vec!["N3B"],
            _ => vec![],
        },
        "VEL" => match t {
            "0.5" => vec!["N0G"],
            "1.5" => vec!["N1G", "NAG"],
            "2.4" => vec!["N2U"],
            "3.1" => vec!["N3U"],
            _ => vec![],
        },
        "CC" => match t {
            "0.5" => vec!["NAC", "N0C"],
            "1.5" => vec!["N1C", "NAC"],
            "2.4" => vec!["N2C"],
            "3.1" => vec!["N3C"],
            _ => vec![],
        },
        "ZDR" => match t {
            "0.5" => vec!["NAX", "N0X"],
            "1.5" => vec!["N1X"],
            "2.4" => vec!["N2X"],
            "3.1" => vec!["N3X"],
            _ => vec![],
        },
        "VIL" => {
            if t == "0.5" {
                vec!["NVL"]
            } else {
                vec![]
            }
        }
        "ET" | "EET" => {
            if t == "0.5" {
                vec!["EET"]
            } else {
                vec![]
            }
        }
        _ => match t {
            "0.5" => vec!["N0B"],
            "1.5" => vec!["N1B", "NAB"],
            "2.4" => vec!["N2B"],
            "3.1" => vec!["N3B"],
            _ => vec![],
        },
    }
}

fn build_product_candidates(family: &str, tilt: &str, cross_tilt: bool) -> Vec<&'static str> {
    let selected = normalize_tilt(tilt);
    let mut ordered_tilts = vec![selected];
    if cross_tilt {
        for t in L3_TILT_VALUES {
            if t != selected {
                ordered_tilts.push(t);
            }
        }
    }

    let mut out = Vec::new();
    for t in ordered_tilts {
        for code in family_products_for_tilt(family, t) {
            if !out.contains(&code) {
                out.push(code);
            }
        }
    }
    out
}

#[derive(Clone, Copy)]
struct TgftpProductCandidate {
    pseudo_product: &'static str,
    ds_code: &'static str,
}

fn tgftp_supported_families(station_kind: &str) -> Vec<String> {
    if station_kind.eq_ignore_ascii_case("tdwr") {
        vec!["REF".to_string(), "VEL".to_string(), "ET".to_string()]
    } else {
        vec![
            "REF".to_string(),
            "VEL".to_string(),
            "CC".to_string(),
            "ZDR".to_string(),
            "ET".to_string(),
        ]
    }
}

fn tgftp_candidates_for_selection(
    station_kind: &str,
    family: &str,
    tilt: &str,
    cross_tilt: bool,
) -> Vec<TgftpProductCandidate> {
    let selected = normalize_tilt(tilt);
    let family_upper = family.to_ascii_uppercase();
    let supported_tilts: Vec<&'static str> = if station_kind.eq_ignore_ascii_case("tdwr") {
        match family_upper.as_str() {
            "REF" => vec!["0.5"],
            "VEL" => vec!["0.5", "1.5", "2.4"],
            "ET" | "EET" => vec!["0.5"],
            _ => vec![],
        }
    } else {
        L3_TILT_VALUES.to_vec()
    };

    let mut ordered_tilts = if supported_tilts.contains(&selected) {
        vec![selected]
    } else {
        supported_tilts.first().copied().into_iter().collect()
    };
    if cross_tilt {
        for t in supported_tilts {
            if t != selected {
                ordered_tilts.push(t);
            }
        }
    }

    let mut out: Vec<TgftpProductCandidate> = Vec::new();
    for t in ordered_tilts {
        let candidates: &[TgftpProductCandidate] = if station_kind.eq_ignore_ascii_case("tdwr") {
            match family_upper.as_str() {
                "REF" => match t {
                    "0.5" => &[TgftpProductCandidate { pseudo_product: "N0B", ds_code: "186zl" }],
                    _ => &[],
                },
                "VEL" => match t {
                    "0.5" => &[TgftpProductCandidate { pseudo_product: "N0G", ds_code: "182v0" }],
                    "1.5" => &[TgftpProductCandidate { pseudo_product: "N1G", ds_code: "182v1" }],
                    "2.4" => &[TgftpProductCandidate { pseudo_product: "N2U", ds_code: "182v2" }],
                    _ => &[],
                },
                "ET" | "EET" => match t {
                    "0.5" => &[TgftpProductCandidate { pseudo_product: "EET", ds_code: "p41et" }],
                    _ => &[],
                },
                _ => &[],
            }
        } else {
            match family_upper.as_str() {
                "REF" => match t {
                    "0.5" => &[TgftpProductCandidate { pseudo_product: "N0B", ds_code: "p94r0" }],
                    "1.5" => &[
                        TgftpProductCandidate { pseudo_product: "N1B", ds_code: "p94r1" },
                        TgftpProductCandidate { pseudo_product: "NAB", ds_code: "p94ra" },
                    ],
                    "2.4" => &[TgftpProductCandidate { pseudo_product: "N2B", ds_code: "p94r2" }],
                    "3.1" => &[TgftpProductCandidate { pseudo_product: "N3B", ds_code: "p94r3" }],
                    _ => &[],
                },
                "VEL" => match t {
                    "0.5" => &[TgftpProductCandidate { pseudo_product: "N0G", ds_code: "p99v0" }],
                    "1.5" => &[
                        TgftpProductCandidate { pseudo_product: "N1G", ds_code: "p99v1" },
                        TgftpProductCandidate { pseudo_product: "NAG", ds_code: "p99va" },
                    ],
                    "2.4" => &[TgftpProductCandidate { pseudo_product: "N2U", ds_code: "p99v2" }],
                    "3.1" => &[TgftpProductCandidate { pseudo_product: "N3U", ds_code: "p99v3" }],
                    _ => &[],
                },
                "CC" => match t {
                    "0.5" => &[
                        TgftpProductCandidate { pseudo_product: "NAC", ds_code: "161ca" },
                        TgftpProductCandidate { pseudo_product: "N0C", ds_code: "161c0" },
                    ],
                    "1.5" => &[
                        TgftpProductCandidate { pseudo_product: "N1C", ds_code: "161c1" },
                        TgftpProductCandidate { pseudo_product: "NAC", ds_code: "161ca" },
                    ],
                    "2.4" => &[TgftpProductCandidate { pseudo_product: "N2C", ds_code: "161c2" }],
                    "3.1" => &[TgftpProductCandidate { pseudo_product: "N3C", ds_code: "161c3" }],
                    _ => &[],
                },
                "ZDR" => match t {
                    "0.5" => &[
                        TgftpProductCandidate { pseudo_product: "NAX", ds_code: "159xa" },
                        TgftpProductCandidate { pseudo_product: "N0X", ds_code: "159x0" },
                    ],
                    "1.5" => &[TgftpProductCandidate { pseudo_product: "N1X", ds_code: "159x1" }],
                    "2.4" => &[TgftpProductCandidate { pseudo_product: "N2X", ds_code: "159x2" }],
                    "3.1" => &[TgftpProductCandidate { pseudo_product: "N3X", ds_code: "159x3" }],
                    _ => &[],
                },
                "ET" | "EET" => {
                    if t == "0.5" {
                        &[TgftpProductCandidate { pseudo_product: "EET", ds_code: "135et" }]
                    } else {
                        &[]
                    }
                }
                _ => &[],
            }
        };

        for candidate in candidates {
            if !out.iter().any(|existing| existing.pseudo_product == candidate.pseudo_product && existing.ds_code == candidate.ds_code) {
                out.push(*candidate);
            }
        }
    }
    out
}

fn tgftp_station_url(station_id: &str, ds_code: &str) -> String {
    format!(
        "{}/DS.{}/SI.{}/sn.last",
        TGFTP_LEVEL3_BASE_URL,
        ds_code,
        station_id.to_ascii_lowercase(),
    )
}

fn format_compact_timestamp_from_ms(unix_ms: i64) -> String {
    let unix_s = unix_ms.div_euclid(1_000);
    let day = unix_s.div_euclid(86_400);
    let sod = unix_s.rem_euclid(86_400);
    let hour = sod / 3_600;
    let min = (sod % 3_600) / 60;
    let sec = sod % 60;
    let (y, m, d) = civil_from_days(day);
    format!("{y:04}{m:02}{d:02}-{hour:02}{min:02}{sec:02}")
}

fn parse_http_header_ms(resp: &reqwest::blocking::Response) -> Option<i64> {
    let parse = |name: reqwest::header::HeaderName| {
        resp.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| httpdate::parse_http_date(s).ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
    };
    parse(reqwest::header::LAST_MODIFIED).or_else(|| parse(reqwest::header::DATE))
}

fn tgftp_probe_latest_blocking(
    station_id: &str,
    candidate: TgftpProductCandidate,
    requested_label: &str,
    fallback: bool,
    cross_tilt: bool,
    max_fresh_age_days: f64,
    current_only: bool,
) -> Result<Option<L3ResolvedKeyMeta>, String> {
    let url = tgftp_station_url(station_id, candidate.ds_code);
    let resp = get_http_client()
        .head(&url)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if status.as_u16() >= 400 {
        return Err(format!("TGFTP probe HTTP {} for {}", status.as_u16(), url));
    }

    let ts_ms = parse_http_header_ms(&resp).unwrap_or_else(now_unix_ms);
    let key = format!(
        "TGFTP:{}:{}:{}:{}",
        station_id.to_ascii_uppercase(),
        candidate.pseudo_product,
        candidate.ds_code,
        format_compact_timestamp_from_ms(ts_ms),
    );
    let age_days = Some((now_unix_ms() - ts_ms) as f64 / 86_400_000.0);
    if current_only && age_days.is_some_and(|age| age > max_fresh_age_days) {
        return Ok(None);
    }
    Ok(Some(L3ResolvedKeyMeta {
        key,
        product: candidate.pseudo_product.to_string(),
        requested_label: requested_label.to_string(),
        fallback,
        cross_tilt,
        historical: age_days.is_some_and(|age| age > max_fresh_age_days),
        age_days,
    }))
}

fn l3_resolve_selection_tgftp_blocking(
    station_id: String,
    station_kind: String,
    family: String,
    tilt: String,
    max_fresh_age_days: Option<f64>,
    current_only: Option<bool>,
) -> Result<L3ResolveSelectionResponse, String> {
    let requested_family = if family.trim().is_empty() {
        "REF".to_string()
    } else {
        family.to_ascii_uppercase()
    };
    let requested_tilt = normalize_tilt(&tilt).to_string();
    let requested_label = selection_label(&requested_family, &requested_tilt);
    let max_age_days = max_fresh_age_days.unwrap_or(2.0).clamp(0.1, 30.0);
    let current_only = current_only.unwrap_or(false);

    let strict_candidates = tgftp_candidates_for_selection(&station_kind, &requested_family, &requested_tilt, false);
    let all_candidates = tgftp_candidates_for_selection(&station_kind, &requested_family, &requested_tilt, true);
    let mut latest = None;

    for candidate in &strict_candidates {
        if let Some(meta) = tgftp_probe_latest_blocking(
            &station_id,
            *candidate,
            &requested_label,
            false,
            false,
            max_age_days,
            current_only,
        )? {
            latest = Some(meta);
            break;
        }
    }

    if latest.is_none() {
        for candidate in &all_candidates {
            if strict_candidates.iter().any(|strict| strict.pseudo_product == candidate.pseudo_product && strict.ds_code == candidate.ds_code) {
                continue;
            }
            if let Some(meta) = tgftp_probe_latest_blocking(
                &station_id,
                *candidate,
                &requested_label,
                true,
                true,
                max_age_days,
                current_only,
            )? {
                latest = Some(meta);
                break;
            }
        }
    }

    if let Some(meta) = latest {
        return Ok(L3ResolveSelectionResponse {
            latest: Some(meta.clone()),
            history: vec![meta],
            available_products: Vec::new(),
        });
    }

    Ok(L3ResolveSelectionResponse {
        latest: None,
        history: Vec::new(),
        available_products: if current_only {
            Vec::new()
        } else {
            tgftp_supported_families(&station_kind)
        },
    })
}

fn list_keys_since_blocking(
    prefix: &str,
    start_after: &str,
    max_pages: usize,
) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut token: Option<String> = None;

    for page in 0..max_pages {
        let res = l3_list_page_blocking(
            prefix.to_string(),
            if page == 0 {
                Some(start_after.to_string())
            } else {
                None
            },
            token.clone(),
            Some(1_000),
        )?;
        out.extend(res.keys);
        if res.next.is_none() {
            break;
        }
        token = res.next;
    }

    Ok(out)
}

fn find_newest_key_since_blocking(
    prefix: &str,
    start_after: &str,
    max_pages: usize,
) -> Result<Option<String>, String> {
    let mut newest = None;
    let mut token: Option<String> = None;

    for page in 0..max_pages {
        let res = l3_list_page_blocking(
            prefix.to_string(),
            if page == 0 {
                Some(start_after.to_string())
            } else {
                None
            },
            token.clone(),
            Some(1_000),
        )?;
        if let Some(last) = res.keys.last() {
            newest = Some(last.clone());
        }
        if res.next.is_none() {
            break;
        }
        token = res.next;
    }

    Ok(newest)
}

fn list_available_products_blocking(station_id: &str) -> Result<Vec<String>, String> {
    let sid = id3(station_id);
    let prefix = format!("{sid}_");
    let mut token: Option<String> = None;
    let mut products = BTreeSet::new();

    for _ in 0..12 {
        let res = l3_list_page_blocking(prefix.clone(), None, token.clone(), Some(1_000))?;
        for k in res.keys {
            if let Some(prod) = k.split('_').nth(1) {
                products.insert(prod.to_string());
            }
        }
        if res.next.is_none() {
            break;
        }
        token = res.next;
    }

    Ok(products.into_iter().collect())
}

fn find_latest_key_for_product_blocking(
    station_id: &str,
    product: &str,
    allow_historical: bool,
    max_fresh_age_days: f64,
) -> Result<Option<String>, String> {
    let sid = id3(station_id);
    let prefix = format!("{sid}_{product}_");
    let lookback_days: &[f64] = if allow_historical {
        &[7.0, 14.0, 30.0, 120.0, 365.0, 730.0]
    } else {
        &[0.5, 1.0, max_fresh_age_days]
    };
    let max_pages = if allow_historical { 12 } else { 8 };

    for days in lookback_days {
        let start_after = format!("{prefix}{}", flat_date_days_ago(*days));
        if let Some(newest) = find_newest_key_since_blocking(&prefix, &start_after, max_pages)? {
            if !allow_historical && !is_fresh_key(&newest, max_fresh_age_days) {
                continue;
            }
            return Ok(Some(newest));
        }
    }

    if !allow_historical {
        return Ok(None);
    }

    // Keep historical fallback bounded to avoid long UI stalls on sparse products.
    Ok(None)
}

fn find_recent_keys_for_product_blocking(
    station_id: &str,
    product: &str,
    max_frames: usize,
    anchor_key: Option<&str>,
) -> Result<Vec<String>, String> {
    let sid = id3(station_id);
    let prefix = format!("{sid}_{product}_");

    let mut keys = list_keys_since_blocking(
        &prefix,
        &format!("{prefix}{}", flat_datetime_minutes_ago(90)),
        15,
    )?;
    if keys.is_empty() {
        if let Some(anchor) = anchor_key {
            if let Some(anchor_ms) = parse_l3_key_timestamp_ms(anchor) {
                let anchor_start = format!(
                    "{prefix}{}",
                    format_flat_datetime_from_ms(anchor_ms - 90 * 60_000)
                );
                keys = list_keys_since_blocking(&prefix, &anchor_start, 30)?;
            }
        }
    }
    if keys.is_empty() {
        if let Some(anchor) = anchor_key {
            return Ok(vec![anchor.to_string()]);
        }
    }
    if keys.len() > max_frames {
        keys = keys[keys.len() - max_frames..].to_vec();
    }
    Ok(keys)
}

fn resolved_meta(
    key: String,
    product: &str,
    requested_label: &str,
    fallback: bool,
    cross_tilt: bool,
    force_historical: Option<bool>,
    max_fresh_age_days: f64,
) -> L3ResolvedKeyMeta {
    let age_days = key_age_days(&key);
    let historical =
        force_historical.unwrap_or_else(|| age_days.is_some_and(|age| age > max_fresh_age_days));
    L3ResolvedKeyMeta {
        key,
        product: product.to_string(),
        requested_label: requested_label.to_string(),
        fallback,
        cross_tilt,
        historical,
        age_days,
    }
}

fn l3_resolve_selection_blocking(
    station_id: String,
    family: String,
    tilt: String,
    max_frames: Option<u32>,
    max_fresh_age_days: Option<f64>,
    current_only: Option<bool>,
    source: Option<String>,
    station_kind: Option<String>,
) -> Result<L3ResolveSelectionResponse, String> {
    if source
        .as_deref()
        .is_some_and(|s| s.eq_ignore_ascii_case("tgftp"))
    {
        return l3_resolve_selection_tgftp_blocking(
            station_id,
            station_kind.unwrap_or_else(|| "wsr".to_string()),
            family,
            tilt,
            max_fresh_age_days,
            current_only,
        );
    }

    let requested_family = if family.trim().is_empty() {
        "REF".to_string()
    } else {
        family.to_ascii_uppercase()
    };
    let requested_tilt = normalize_tilt(&tilt).to_string();
    let requested_label = selection_label(&requested_family, &requested_tilt);
    let max_frames = max_frames.unwrap_or(1).clamp(1, 24) as usize;
    let max_age_days = max_fresh_age_days.unwrap_or(2.0).clamp(0.1, 30.0);
    let current_only = current_only.unwrap_or(false);

    let strict_candidates = build_product_candidates(&requested_family, &requested_tilt, false);
    let all_candidates = build_product_candidates(&requested_family, &requested_tilt, true);
    let cross_tilt_candidates: Vec<&str> = all_candidates
        .iter()
        .copied()
        .filter(|code| !strict_candidates.contains(code))
        .collect();
    let requested_product = strict_candidates
        .first()
        .copied()
        .or_else(|| all_candidates.first().copied());

    let mut latest: Option<L3ResolvedKeyMeta> = None;

    for product in &strict_candidates {
        if let Some(key) =
            find_latest_key_for_product_blocking(&station_id, product, false, max_age_days)?
        {
            latest = Some(resolved_meta(
                key,
                product,
                &requested_label,
                requested_product.is_some_and(|rp| rp != *product),
                false,
                None,
                max_age_days,
            ));
            break;
        }
    }

    if latest.is_none() && !current_only {
        for product in &strict_candidates {
            if let Some(key) =
                find_latest_key_for_product_blocking(&station_id, product, true, max_age_days)?
            {
                latest = Some(resolved_meta(
                    key,
                    product,
                    &requested_label,
                    requested_product.is_some_and(|rp| rp != *product),
                    false,
                    Some(true),
                    max_age_days,
                ));
                break;
            }
        }
    }

    if latest.is_none() {
        for product in &cross_tilt_candidates {
            if let Some(key) =
                find_latest_key_for_product_blocking(&station_id, product, false, max_age_days)?
            {
                latest = Some(resolved_meta(
                    key,
                    product,
                    &requested_label,
                    true,
                    true,
                    None,
                    max_age_days,
                ));
                break;
            }
        }
    }

    if let Some(latest_meta) = latest.clone() {
        if max_frames <= 1 {
            return Ok(L3ResolveSelectionResponse {
                latest: Some(latest_meta.clone()),
                history: vec![latest_meta],
                available_products: Vec::new(),
            });
        }

        let mut keys = find_recent_keys_for_product_blocking(
            &station_id,
            &latest_meta.product,
            max_frames,
            Some(&latest_meta.key),
        )?;
        if !keys.iter().any(|k| k == &latest_meta.key) {
            keys.push(latest_meta.key.clone());
        }
        keys.sort();
        keys.dedup();
        if keys.len() > max_frames {
            keys = keys[keys.len() - max_frames..].to_vec();
        }

        let history = keys
            .into_iter()
            .map(|k| {
                resolved_meta(
                    k,
                    &latest_meta.product,
                    &requested_label,
                    latest_meta.fallback,
                    latest_meta.cross_tilt,
                    if latest_meta.historical {
                        Some(true)
                    } else {
                        None
                    },
                    max_age_days,
                )
            })
            .collect();

        return Ok(L3ResolveSelectionResponse {
            latest: Some(latest_meta),
            history,
            available_products: Vec::new(),
        });
    }

    Ok(L3ResolveSelectionResponse {
        latest: None,
        history: Vec::new(),
        available_products: if current_only {
            Vec::new()
        } else {
            list_available_products_blocking(&station_id)?
        },
    })
}

fn extract_xml_tag_values(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let mut out = Vec::new();
    let mut cursor = 0usize;

    while let Some(start_rel) = xml[cursor..].find(&open) {
        let start = cursor + start_rel + open.len();
        let Some(end_rel) = xml[start..].find(&close) else {
            break;
        };
        let end = start + end_rel;
        out.push(xml[start..end].to_string());
        cursor = end + close.len();
    }

    out
}

fn extract_xml_tag_value(xml: &str, tag: &str) -> Option<String> {
    extract_xml_tag_values(xml, tag).into_iter().next()
}

fn validate_query_part(name: &str, value: &str, max_len: usize) -> Result<(), String> {
    if value.len() > max_len {
        return Err(format!("{name} too long"));
    }
    if value.contains('\n') || value.contains('\r') {
        return Err(format!("{name} contains invalid characters"));
    }
    Ok(())
}

fn l3_list_page_blocking(
    prefix: String,
    start_after: Option<String>,
    continuation_token: Option<String>,
    max_keys: Option<u32>,
) -> Result<L3ListPageResponse, String> {
    if prefix.is_empty() {
        return Err("prefix is required".into());
    }
    validate_query_part("prefix", &prefix, 256)?;

    if let Some(ref s) = start_after {
        validate_query_part("start_after", s, 256)?;
    }
    if let Some(ref s) = continuation_token {
        validate_query_part("continuation_token", s, 4096)?;
    }

    let max_keys = max_keys.unwrap_or(1000).clamp(1, 1000);
    let mut url = reqwest::Url::parse(S3_LEVEL3_LIST_URL).map_err(|e| e.to_string())?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("list-type", "2");
        q.append_pair("prefix", &prefix);
        q.append_pair("max-keys", &max_keys.to_string());
        if let Some(token) = continuation_token.as_ref().filter(|s| !s.is_empty()) {
            q.append_pair("continuation-token", token);
        } else if let Some(start_after) = start_after.as_ref().filter(|s| !s.is_empty()) {
            q.append_pair("start-after", start_after);
        }
    }

    let resp = get_http_client()
        .get(url)
        .header("Accept", "application/xml,text/xml,*/*")
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if status >= 400 {
        return Err(format!("L3 list HTTP {status}"));
    }
    let xml = resp.text().map_err(|e| e.to_string())?;

    let mut keys = extract_xml_tag_values(&xml, "Key");
    keys.retain(|k| !k.ends_with('/'));

    Ok(L3ListPageResponse {
        keys,
        next: extract_xml_tag_value(&xml, "NextContinuationToken"),
    })
}

#[tauri::command]
async fn l3_list_page(
    prefix: String,
    start_after: Option<String>,
    continuation_token: Option<String>,
    max_keys: Option<u32>,
) -> Result<L3ListPageResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        l3_list_page_blocking(prefix, start_after, continuation_token, max_keys)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn l3_resolve_selection(
    station_id: String,
    family: String,
    tilt: String,
    max_frames: Option<u32>,
    max_fresh_age_days: Option<f64>,
    current_only: Option<bool>,
    source: Option<String>,
    station_kind: Option<String>,
) -> Result<L3ResolveSelectionResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        l3_resolve_selection_blocking(
            station_id,
            family,
            tilt,
            max_frames,
            max_fresh_age_days,
            current_only,
            source,
            station_kind,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn l3_warm_keys(
    state: tauri::State<Backend>,
    keys: Vec<String>,
    palettes: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if keys.is_empty() {
        return Ok(serde_json::json!({ "ok": true, "warmed": 0 }));
    }
    let keys: Vec<String> = keys
        .into_iter()
        .filter(|k| !k.is_empty())
        .take(64)
        .collect();
    if keys.is_empty() {
        return Ok(serde_json::json!({ "ok": true, "warmed": 0 }));
    }

    let mut guard = acquire_backend(&state.0);

    if let BackendState::Failed(prev_err) = &*guard {
        match spawn_backend() {
            Ok(inner) => *guard = BackendState::Ready(inner),
            Err(new_err) => {
                return Err(format!(
                    "Backend unavailable.\nPrevious error: {}\nRestart error: {}",
                    prev_err, new_err
                ))
            }
        }
    }

    let inner = match &mut *guard {
        BackendState::Ready(inner) => inner,
        BackendState::Failed(err) => return Err(err.clone()),
    };

    let mut req_obj = serde_json::json!({
        "cmd": "warm_l3",
        "keys": keys,
    });
    if let Some(p) = palettes {
        req_obj["palettes"] = p;
    }

    match request_backend(inner, req_obj.clone()) {
        Ok(val) => Ok(val),
        Err(first_err) => {
            if !should_restart_backend(&first_err) {
                return Err(first_err);
            }
            let restarted = spawn_backend().map_err(|restart_err| {
                format!(
                    "Backend request failed: {}\nBackend restart failed: {}",
                    first_err, restart_err
                )
            })?;
            *inner = restarted;
            request_backend(inner, req_obj).map_err(|retry_err| {
                format!(
                    "Backend request failed: {}\nBackend restarted but retry failed: {}",
                    first_err, retry_err
                )
            })
        }
    }
}

fn local_nwws_bridge_script_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("nwws-backend")
        .join("nwws-bridge.cjs")
}

fn bundled_nwws_bridge_script_candidates(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|err| format!("Could not resolve resource dir: {err}"))?;
    let mut paths = Vec::new();

    push_unique(
        &mut paths,
        resource_dir.join("nwws-backend").join("nwws-bridge.cjs"),
    );
    push_unique(
        &mut paths,
        resource_dir
            .join("_up_")
            .join("nwws-backend")
            .join("nwws-bridge.cjs"),
    );

    if let Ok(path) = app
        .path()
        .resolve("nwws-backend/nwws-bridge.cjs", BaseDirectory::Resource)
    {
        push_unique(&mut paths, path);
    }
    if let Ok(path) = app.path().resolve(
        "../nwws-backend/nwws-bridge.cjs",
        BaseDirectory::Resource,
    ) {
        push_unique(&mut paths, path);
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            push_unique(
                &mut paths,
                exe_dir
                    .join("resources")
                    .join("nwws-backend")
                    .join("nwws-bridge.cjs"),
            );
            push_unique(
                &mut paths,
                exe_dir
                    .join("resources")
                    .join("_up_")
                    .join("nwws-backend")
                    .join("nwws-bridge.cjs"),
            );
            push_unique(
                &mut paths,
                exe_dir
                    .join("Resources")
                    .join("nwws-backend")
                    .join("nwws-bridge.cjs"),
            );
            push_unique(
                &mut paths,
                exe_dir
                    .join("Resources")
                    .join("_up_")
                    .join("nwws-backend")
                    .join("nwws-bridge.cjs"),
            );
        }
    }

    Ok(paths)
}

fn resolve_nwws_bridge_script(app: &AppHandle) -> Result<PathBuf, String> {
    for bundled in bundled_nwws_bridge_script_candidates(app)? {
        if bundled.is_file() {
            return Ok(bundled);
        }
    }

    let local = local_nwws_bridge_script_path();
    if local.is_file() {
        return Ok(local);
    }

    Err("NWWS bridge script was not found".into())
}

fn ensure_nwws_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Could not resolve app data dir: {err}"))?
        .join("nwws");
    fs::create_dir_all(&dir).map_err(|err| format!("Could not create NWWS data dir: {err}"))?;
    Ok(dir)
}

fn read_nwws_bridge_stdout(stdout: impl Read + Send + 'static, app: AppHandle) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(payload) => {
                    let event_type = payload
                        .get("type")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    let event_payload = payload
                        .get("payload")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    match event_type {
                        "status" => {
                            let _ = app.emit("nwws-status", event_payload);
                        }
                        "alerts" => {
                            let _ = app.emit("nwws-alerts", event_payload);
                        }
                        "log" => {
                            let _ = app.emit("nwws-log", event_payload);
                        }
                        _ => {
                            let _ = app.emit("nwws-log", serde_json::json!({
                                "level": "info",
                                "message": line,
                            }));
                        }
                    }
                }
                Err(_) => {
                    let _ = app.emit("nwws-log", serde_json::json!({
                        "level": "info",
                        "message": line,
                    }));
                }
            }
        }
    });
}

fn read_nwws_bridge_stderr(stderr: impl Read + Send + 'static, app: AppHandle) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if !line.trim().is_empty() {
                let _ = app.emit("nwws-log", serde_json::json!({
                    "level": "error",
                    "message": line,
                }));
            }
        }
    });
}

#[tauri::command]
fn start_nwws_bridge(
    app: AppHandle,
    state: State<'_, NwwsBridgeState>,
    username: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "NWWS bridge state is poisoned".to_string())?;

    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
            }
            Ok(None) => {
                return Ok(());
            }
            Err(err) => {
                *guard = None;
                return Err(format!("Could not inspect NWWS bridge process: {err}"));
            }
        }
    }

    let script = resolve_nwws_bridge_script(&app)?;
    let script_dir = script
        .parent()
        .ok_or_else(|| "NWWS bridge directory could not be resolved".to_string())?
        .to_path_buf();
    let script_name: OsString = script
        .file_name()
        .ok_or_else(|| "NWWS bridge script file name could not be resolved".to_string())?
        .to_os_string();
    let data_dir = ensure_nwws_data_dir(&app)?;
    let username = username.unwrap_or_default().trim().to_string();
    let password = password.unwrap_or_default().trim().to_string();

    let mut command = Command::new("node");
    command
        .arg(script_name)
        .current_dir(&script_dir)
        .env("NWWS_BACKEND_DATA_DIR", &data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !username.is_empty() && !password.is_empty() {
        command
            .env("NWWS_USERNAME", username)
            .env("NWWS_PASSWORD", password);
    }
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|err| format!("Could not start Node NWWS bridge: {err}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not capture NWWS bridge stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not capture NWWS bridge stderr".to_string())?;

    read_nwws_bridge_stdout(stdout, app.clone());
    read_nwws_bridge_stderr(stderr, app.clone());

    let _ = app.emit(
        "nwws-status",
        serde_json::json!({
            "phase": "starting",
            "message": "NWWS bridge launched",
            "alertCount": 0
        }),
    );

    *guard = Some(child);
    Ok(())
}

#[tauri::command]
fn stop_nwws_bridge(state: State<'_, NwwsBridgeState>) -> Result<(), String> {
    stop_nwws_bridge_process(&state.child);
    Ok(())
}

#[tauri::command]
fn open_warning_dashboard(app: AppHandle) -> Result<(), String> {
    const LABEL: &str = "warning-dashboard";
    const LOG_EVENT: &str = "dashboard-window-log";

    let _ = app.emit(
        LOG_EVENT,
        serde_json::json!({
            "phase": "command",
            "detail": "open requested",
            "label": LABEL
        }),
    );

    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit(
            LOG_EVENT,
            serde_json::json!({
                "phase": "command",
                "detail": "reused existing window",
                "label": LABEL
            }),
        );
        return Ok(());
    }

    let build_app = app.clone();
    std::thread::Builder::new()
        .name(String::from("warning-dashboard-builder"))
        .spawn(move || {
            let emit_log = |phase: &str, detail: &str, url: Option<String>, status: Option<u16>| {
                let _ = build_app.emit(
                    LOG_EVENT,
                    serde_json::json!({
                        "phase": phase,
                        "detail": detail,
                        "label": LABEL,
                        "url": url,
                        "status": status
                    }),
                );
            };

            emit_log("thread", "dashboard builder thread started", None, None);
            emit_log("build", "creating warning dashboard window", Some(String::from("index.html")), None);

            let nav_app = build_app.clone();
            let req_app = build_app.clone();
            let load_app = build_app.clone();

            match WebviewWindowBuilder::new(&build_app, LABEL, WebviewUrl::App("index.html".into()))
                .title("Warning Dashboard")
                .inner_size(980.0, 760.0)
                .min_inner_size(760.0, 520.0)
                .resizable(true)
                .center()
                .initialization_script(
                    r#"
                    window.__RADAR_DASHBOARD_MODE__ = true;
                    document.documentElement.setAttribute('data-dashboard-mode', '1');
                    "#,
                )
                .on_navigation(move |url| {
                    let _ = nav_app.emit(
                        LOG_EVENT,
                        serde_json::json!({
                            "phase": "navigate",
                            "detail": "navigation requested",
                            "label": LABEL,
                            "url": url.to_string()
                        }),
                    );
                    true
                })
                .on_web_resource_request(move |request, response| {
                    let uri = request.uri().to_string();
                    let path = request.uri().path().to_string();
                    if path == "/" || path.ends_with("index.html") || path.ends_with("dashboard-app.js") || path.ends_with("radar.js") {
                        let _ = req_app.emit(
                            LOG_EVENT,
                            serde_json::json!({
                                "phase": "resource",
                                "detail": "resource requested",
                                "label": LABEL,
                                "url": uri,
                                "status": response.status().as_u16()
                            }),
                        );
                    }
                })
                .on_page_load(move |_window, payload| {
                    let phase = match payload.event() {
                        PageLoadEvent::Started => "started",
                        PageLoadEvent::Finished => "finished",
                    };
                    let _ = load_app.emit(
                        LOG_EVENT,
                        serde_json::json!({
                            "phase": phase,
                            "url": payload.url(),
                            "label": LABEL
                        }),
                    );
                })
                .build()
            {
                Ok(window) => {
                    emit_log("build", "warning dashboard window created", Some(String::from("index.html")), None);
                    if let Ok(url) = window.url() {
                        emit_log("build", "window current url", Some(url.to_string()), None);
                    }
                    let _ = window.set_focus();
                }
                Err(e) => {
                    emit_log("error", &format!("dashboard window create failed: {e}"), None, None);
                }
            }
        })
        .map_err(|e| format!("dashboard builder thread spawn failed: {e}"))?;

    let _ = app.emit(
        LOG_EVENT,
        serde_json::json!({
            "phase": "command",
            "detail": "window build scheduled on worker thread",
            "label": LABEL,
            "url": "index.html"
        }),
    );

    Ok(())
}

#[tauri::command]
async fn decode_key(
    app: AppHandle,
    state: tauri::State<'_, Backend>,
    key: String,
    palettes: Option<serde_json::Value>,
) -> Result<tauri::ipc::Response, String> {
    let pool = state.0.clone();
    let key_for_sig = key.clone();
    let palettes_for_sig = palettes.clone();
    let signature = serde_json::json!({
        "key": key_for_sig,
        "palettes": palettes_for_sig,
    });
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(bytes) = read_decode_cache_bytes(&app, "l3", &signature) {
            return Ok(tauri::ipc::Response::new(bytes));
        }

        let mut guard = acquire_backend(&pool);

        if let BackendState::Failed(prev_err) = &*guard {
            match spawn_backend() {
                Ok(inner) => *guard = BackendState::Ready(inner),
                Err(new_err) => {
                    return Err(format!(
                        "Backend unavailable.\nPrevious error: {}\nRestart error: {}",
                        prev_err, new_err
                    ))
                }
            }
        }

        let inner = match &mut *guard {
            BackendState::Ready(inner) => inner,
            BackendState::Failed(err) => return Err(err.clone()),
        };

        let mut req_obj = serde_json::json!({ "key": key });
        if let Some(ref p) = palettes {
            req_obj["palettes"] = p.clone();
        }

        match request_decode_binary(inner, req_obj.clone()) {
            Ok(bytes) => {
                if let Err(err) = write_decode_cache_bytes(&app, "l3", &signature, &bytes) {
                    eprintln!("[radar] decode cache write failed: {err}");
                }
                Ok(tauri::ipc::Response::new(bytes))
            }
            Err(first_err) => {
                if !should_restart_backend(&first_err) {
                    return Err(first_err);
                }

                let restarted = spawn_backend().map_err(|restart_err| {
                    format!(
                        "Backend request failed: {}\nBackend restart failed: {}",
                        first_err, restart_err
                    )
                })?;

                *inner = restarted;
                request_decode_binary(inner, req_obj)
                    .map(|bytes| {
                        if let Err(err) = write_decode_cache_bytes(&app, "l3", &signature, &bytes) {
                            eprintln!("[radar] decode cache write failed: {err}");
                        }
                        tauri::ipc::Response::new(bytes)
                    })
                    .map_err(|retry_err| {
                        format!(
                            "Backend request failed: {}\nBackend restarted but retry failed: {}",
                            first_err, retry_err
                        )
                    })
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}


// ── HTTP proxy for camera feeds ───────────────────────────────────────────────
static HTTP_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
static CHASER_HTTP_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

fn get_http_client() -> &'static reqwest::blocking::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
            .connect_timeout(Duration::from_secs(6))
            .timeout(Duration::from_secs(20))
            .pool_max_idle_per_host(8)
            .build()
            .expect("HTTP client build failed")
    })
}

fn get_chaser_http_client() -> &'static reqwest::blocking::Client {
    CHASER_HTTP_CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(4)
            .build()
            .expect("chaser HTTP client build failed")
    })
}

#[derive(serde::Serialize)]
struct FetchBase64Response {
    status: u16,
    content_type: String,
    body_base64: String,
    final_url: String,
}

fn do_fetch(url: String, timeout_ms: Option<u64>) -> Result<FetchBase64Response, String> {
    do_fetch_inner(url, 0, timeout_ms)
}

fn do_fetch_inner(url: String, depth: u8, timeout_ms: Option<u64>) -> Result<FetchBase64Response, String> {
    if depth > 5 {
        return Err("Too many redirects while fetching URL".into());
    }

    let timeout = timeout_ms
        .filter(|ms| *ms >= 1_000)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_secs(20));

    // Arkansas protected feed: resolve initial redirect manually so the next
    // host (worldssl/skyvdn) gets host-appropriate headers on retry.
    if url.contains("actis.idrivearkansas.com") {
        let actis_client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
            .connect_timeout(Duration::from_secs(6))
            .timeout(timeout)
            .build()
            .map_err(|e| e.to_string())?;

        let resp = actis_client
            .get(&url)
            .header("Accept", "*/*")
            .header("Origin", "https://www.idrivearkansas.com")
            .header("Referer", "https://www.idrivearkansas.com/")
            .header("Sec-Fetch-Site", "cross-site")
            .header("Sec-Fetch-Mode", "cors")
            .header("Sec-Fetch-Dest", "empty")
            .send()
            .map_err(|e| e.to_string())?;

        let status = resp.status().as_u16();
        if (300..400).contains(&status) {
            if let Some(loc) = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()) {
                let next = if loc.starts_with("http://") || loc.starts_with("https://") {
                    loc.to_string()
                } else if let Ok(base) = reqwest::Url::parse(&url) {
                    base.join(loc).map(|u| u.to_string()).unwrap_or_else(|_| loc.to_string())
                } else {
                    loc.to_string()
                };
                return do_fetch_inner(next, depth + 1, timeout_ms);
            }
        }

        let final_url = resp.url().to_string();
        let content_type = resp.headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = resp.bytes().map_err(|e| e.to_string())?;
        return Ok(FetchBase64Response {
            status,
            content_type,
            body_base64: B64.encode(&bytes),
            final_url,
        });
    }

    let is_chaser_feed = url.contains("data2.weatherwise.app/chasers/chasers.geojson")
        || url.contains("data3.radaromega.com/api/mobile-devices");
    let timeout_override = timeout_ms.filter(|ms| *ms >= 1_000);
    let owned_client;
    let client = if is_chaser_feed && timeout_override.is_none() {
        get_chaser_http_client()
    } else if timeout_override.is_none() {
        get_http_client()
    } else {
        owned_client = reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
            .connect_timeout(Duration::from_secs(6))
            .timeout(timeout)
            .pool_max_idle_per_host(8)
            .build()
            .map_err(|e| e.to_string())?;
        &owned_client
    };
    let mut req = client.get(&url).header("Accept", "*/*");
    let should_bypass_cache = is_chaser_feed || url.contains("_=");
    if should_bypass_cache {
        req = req
            .header(reqwest::header::CACHE_CONTROL, "no-cache, no-store, max-age=0")
            .header("Pragma", "no-cache")
            .header("Expires", "0");
    }

    // State-specific headers — specific subdomains MUST come before generic domain matches.
    if url.contains("idrivearkansas.com") || url.contains("worldssl.net") || url.contains("skyvdn.com") {
        let origin = if url.contains("worldssl.net") || url.contains("skyvdn.com") { "null" } else { "https://www.idrivearkansas.com" };
        req = req.header("Origin", origin).header("Referer", "https://www.idrivearkansas.com/");
    } else if url.contains("kscam.carsprogram.org") {
        // Kansas
        req = req.header("Origin", "https://www.kandrive.org").header("Referer", "https://www.kandrive.org/");
    } else if url.contains("cocam.carsprogram.org") {
        // Colorado
        req = req.header("Origin", "https://cotrip.org").header("Referer", "https://cotrip.org/");
    } else if url.contains("trafficwise.org") || url.contains("carsprogram.org") {
        // Indiana (catch-all for remaining carsprogram.org subdomains)
        req = req.header("Origin", "https://511in.org").header("Referer", "https://511in.org/");
    } else if url.contains("divas.cloud") {
        req = req.header("Origin", "https://www.fl511.com").header("Referer", "https://www.fl511.com/");
    } else if url.contains("arcadis-ivds.com") {
        req = req.header("Origin", "https://www.511pa.com").header("Referer", "https://www.511pa.com/");
    } else if url.contains("wink.co") || url.contains("xcmdata.org") {
        req = req.header("Origin", "https://www.511nj.org").header("Referer", "https://www.511nj.org/");
    } else if url.contains("navigator.dot.ga.gov") {
        req = req.header("Origin", "https://511ga.org").header("Referer", "https://511ga.org/");
    } else if url.contains("511ga.org") {
        req = req.header("Origin", "https://511ga.org").header("Referer", "https://511ga.org/");
    } else if url.contains("sha.maryland.gov") {
        req = req.header("Origin", "https://chart.maryland.gov").header("Referer", "https://chart.maryland.gov/");
    } else if url.contains("video.dot.state.mn.us") {
        req = req.header("Origin", "https://511mn.org").header("Referer", "https://511mn.org/");
    } else if url.contains("511la.org") || url.contains("dotd.la.gov") {
        // Louisiana
        req = req.header("Origin", "https://www.511la.org").header("Referer", "https://www.511la.org/");
    } else if url.contains("colewx.workers.dev") {
        // colewx worker — no special headers needed, just fetch
    } else if url.contains("txdot.gov") {
        req = req.header("Origin", "https://www.txdot.gov").header("Referer", "https://www.txdot.gov/");
    } else if url.contains("oktraffic.org") || url.contains("oktrafficradar.org") {
        req = req.header("Origin", "https://www.oktraffic.org").header("Referer", "https://www.oktraffic.org/");
    } else if url.contains("cwwp2.dot.ca.gov") {
        // California
        req = req.header("Origin", "https://quickmap.dot.ca.gov").header("Referer", "https://quickmap.dot.ca.gov/");
    } else if url.contains("az511.gov") {
        // Arizona
        req = req.header("Origin", "https://az511.gov").header("Referer", "https://az511.gov/");
    } else if url.contains("nmroads.com") {
        // New Mexico
        req = req.header("Origin", "https://nmroads.com").header("Referer", "https://nmroads.com/");
    } else if url.contains("api.algotraffic.com") {
        // Alabama snapshots
        req = req.header("Origin", "https://algotraffic.com").header("Referer", "https://algotraffic.com/");
    } else if url.contains("wowza.com") || url.contains("-fastly/") || url.contains(".stream/") {
        // Alabama / other wowza HLS streams
        req = req.header("Referer", "https://algotraffic.com/");
    } else if url.contains("dot511.nebraska.gov") || url.contains("dot.nebraska.gov") {
        // Nebraska
        req = req.header("Origin", "https://511.nebraska.gov").header("Referer", "https://511.nebraska.gov/");
    } else if url.contains("skyvdn.com") {
        // Skyline/skyvdn streams used by SC, TN, NY, and others — requires Origin: null
        req = req.header("Origin", "null").header("Referer", "https://www.idrivearkansas.com/");
    } else if url.contains("511ny.org") {
        // New York 511 camera snapshots
        req = req.header("Origin", "https://511ny.org").header("Referer", "https://511ny.org/");
    } else if url.contains("tnsnapshots.com") {
        // Tennessee thumbnails
        req = req.header("Referer", "https://www.tn511.com/");
    } else if url.contains("eapps.ncdot.gov") {
        // North Carolina
        req = req.header("Origin", "https://www.ncdot.gov").header("Referer", "https://www.ncdot.gov/");
    } else if url.contains("trimarc.org") {
        // Kentucky
        req = req.header("Referer", "https://www.511ky.org/");
    } else if url.contains("itscameras.dot.state.oh.us") {
        // Ohio
        req = req.header("Referer", "https://www.ohgo.com/");
    } else if url.contains("tripcheck.com") {
        // Oregon
        req = req.header("Origin", "https://www.tripcheck.com").header("Referer", "https://www.tripcheck.com/");
    } else if url.contains("wsdot.wa.gov") {
        // Washington
        req = req.header("Referer", "https://wsdot.com/");
    } else if url.contains("mt.cdn.iteris-atis.com") {
        // Montana RWIS
        req = req.header("Referer", "https://www.mdt.mt.gov/travinfo/");
    } else if url.contains("511.idaho.gov") {
        // Idaho
        req = req.header("Origin", "https://511.idaho.gov").header("Referer", "https://511.idaho.gov/");
    }

    let resp = req.send().map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let content_type = resp.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    Ok(FetchBase64Response {
        status,
        content_type,
        body_base64: B64.encode(&bytes),
        final_url,
    })
}

// Run the blocking HTTP fetch on a dedicated thread so it never stalls the async executor.
#[tauri::command]
async fn fetch_url_base64(url: String, timeout_ms: Option<u64>) -> Result<FetchBase64Response, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http/https URLs allowed".into());
    }
    tauri::async_runtime::spawn_blocking(move || do_fetch(url, timeout_ms))
        .await
        .map_err(|e| e.to_string())?
}

// ── FL511 / divas.cloud two-step HLS token resolution ─────────────────────────
//
// Flow:
//   Step 0: GET https://www.fl511.com/map  → scrape ASP.NET CSRF token + session cookies
//   Step 1: GET fl511.com/Camera/GetVideoUrl?imageId=<id>  → { token, sourceId, systemSourceId }
//   Step 2: POST divas.cloud/.../GetSecureTokenUriBySourceId  → "?token=<hex>"
//   Result: assemble final m3u8 URL from the divas.cloud channel URL + token

const FL511_TOKEN_TIMEOUT: Duration = Duration::from_secs(20);
const FL511_CSRF_TTL: Duration = Duration::from_secs(300);

struct CsrfCache {
    token: String,
    fetched_at: Instant,
}

static FL511_CSRF: Mutex<Option<CsrfCache>> = Mutex::new(None);

#[derive(serde::Deserialize)]
struct Fl511VideoInfo {
    token: String,
    #[serde(rename = "sourceId")]
    source_id: String,
    #[serde(rename = "systemSourceId")]
    system_source_id: String,
}

#[derive(serde::Serialize)]
struct Fl511StreamResult {
    stream_token: String,
    stream_url: String,
}

fn extract_csrf_token(html: &str) -> Option<String> {
    let marker = "__RequestVerificationToken";
    let pos = html.find(marker)?;
    let context = &html[pos..std::cmp::min(pos + 600, html.len())];
    for prefix in &["value=\"", "content=\""] {
        if let Some(vpos) = context.find(prefix) {
            let after = &context[vpos + prefix.len()..];
            if let Some(end) = after.find('"') {
                let tok = &after[..end];
                if tok.len() > 20 {
                    return Some(tok.to_string());
                }
            }
        }
    }
    None
}

fn fl511_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
        .connect_timeout(Duration::from_secs(8))
        .timeout(FL511_TOKEN_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

fn fetch_fl511_session(client: &reqwest::blocking::Client) -> Result<(String, String), String> {
    // Check cache first (we still re-fetch /map for fresh session cookies)
    let cached = FL511_CSRF.lock().ok().and_then(|g| {
        g.as_ref()
            .filter(|c| c.fetched_at.elapsed() < FL511_CSRF_TTL)
            .map(|c| c.token.clone())
    });

    let resp = client
        .get("https://www.fl511.com/map")
        .header("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
        .header("Sec-Fetch-Dest", "document")
        .header("Sec-Fetch-Mode", "navigate")
        .header("Sec-Fetch-Site", "none")
        .send()
        .map_err(|e| format!("FL511 Step0 failed: {e}"))?;

    if resp.status().as_u16() >= 400 {
        return Err(format!("FL511 Step0 HTTP {}", resp.status().as_u16()));
    }

    let cookie_header: String = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|s| s.split(';').next())
        .collect::<Vec<_>>()
        .join("; ");

    if let Some(token) = cached {
        return Ok((token, cookie_header));
    }

    let html = resp.text().map_err(|e| format!("FL511 Step0 body: {e}"))?;
    let token = extract_csrf_token(&html)
        .ok_or_else(|| "FL511 Step0: CSRF token not found in page".to_string())?;

    if let Ok(mut g) = FL511_CSRF.lock() {
        *g = Some(CsrfCache { token: token.clone(), fetched_at: Instant::now() });
    }

    Ok((token, cookie_header))
}

fn fetch_fl511_video_url(client: &reqwest::blocking::Client, image_id: u32) -> Result<Fl511VideoInfo, String> {
    let (csrf_token, cookie_header) = fetch_fl511_session(client)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let url = format!("https://www.fl511.com/Camera/GetVideoUrl?imageId={}&_={}", image_id, ts);

    let mut req = client
        .get(&url)
        .header("Accept", "application/json, text/javascript, */*; q=0.01")
        .header("Referer", "https://www.fl511.com/map")
        .header("Origin", "https://www.fl511.com")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "same-origin")
        .header("__RequestVerificationToken", &csrf_token);

    if !cookie_header.is_empty() {
        req = req.header("Cookie", &cookie_header);
    }

    let resp = req.send().map_err(|e| format!("FL511 Step1 request: {e}"))?;
    let status = resp.status().as_u16();
    if status == 400 || status == 403 {
        // CSRF expired — clear cache and return error so caller can retry
        if let Ok(mut g) = FL511_CSRF.lock() { *g = None; }
        return Err(format!("FL511 Step1 HTTP {status} (CSRF expired, cleared cache)"));
    }
    if status < 200 || status >= 400 {
        return Err(format!("FL511 Step1 HTTP {status}"));
    }

    let body = resp.bytes().map_err(|e| format!("FL511 Step1 body: {e}"))?;
    serde_json::from_slice::<Fl511VideoInfo>(&body)
        .map_err(|e| format!("FL511 Step1 parse: {e} body={}", String::from_utf8_lossy(&body).chars().take(200).collect::<String>()))
}

fn fetch_divas_token(
    client: &reqwest::blocking::Client,
    token: String,
    source_id: String,
    system_source_id: String,
    csrf_token: Option<String>,
) -> Result<String, String> {
    let body = serde_json::json!({ "token": token, "sourceId": source_id, "systemSourceId": system_source_id });

    let effective_csrf = csrf_token.filter(|t| !t.is_empty()).or_else(|| {
        FL511_CSRF.lock().ok().and_then(|g| {
            g.as_ref()
                .filter(|c| c.fetched_at.elapsed() < FL511_CSRF_TTL)
                .map(|c| c.token.clone())
        })
    });

    let body_str = body.to_string();
    let mut req = client
        .post("https://divas.cloud/VDS-API/SecureTokenUri/GetSecureTokenUriBySourceId")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/plain, */*")
        .header("Origin", "https://www.fl511.com")
        .header("Referer", "https://www.fl511.com/")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "cross-site")
        .body(body_str);

    if let Some(ref csrf) = effective_csrf {
        req = req.header("__RequestVerificationToken", csrf.as_str());
    }

    let resp = req.send().map_err(|e| format!("divas Step2 request: {e}"))?;
    let status = resp.status().as_u16();
    if status < 200 || status >= 400 {
        return Err(format!("divas Step2 HTTP {status}"));
    }

    // Response is a JSON-quoted string like `"?token=d725ef…"`
    let body_bytes = resp.bytes().map_err(|e| format!("divas Step2 body: {e}"))?;
    let token_qs: String = serde_json::from_slice(&body_bytes)
        .map_err(|e| format!("divas Step2 parse: {e} body={}", String::from_utf8_lossy(&body_bytes).chars().take(200).collect::<String>()))?;
    Ok(token_qs
        .trim_start_matches('?')
        .trim_start_matches("token=")
        .to_string())
}

#[tauri::command]
fn fetch_fl511_stream(image_id: u32, channel_url: String) -> Result<Fl511StreamResult, String> {
    let client = fl511_client()?;

    // Retry once in case CSRF token was stale
    let info = match fetch_fl511_video_url(&client, image_id) {
        Ok(i) => i,
        Err(e) if e.contains("CSRF expired") => {
            fetch_fl511_video_url(&client, image_id)
                .map_err(|e2| format!("FL511 retry failed: {e2} (original: {e})"))?
        }
        Err(e) => return Err(e),
    };

    let csrf = FL511_CSRF.lock().ok().and_then(|g| {
        g.as_ref()
            .filter(|c| c.fetched_at.elapsed() < FL511_CSRF_TTL)
            .map(|c| c.token.clone())
    });

    let stream_token = fetch_divas_token(&client, info.token, info.source_id, info.system_source_id, csrf)?;

    // If caller provided a channel URL, append the token; otherwise JS will build it
    let stream_url = if !channel_url.is_empty() {
        let sep = if channel_url.contains('?') { '&' } else { '?' };
        format!("{}{}token={}", channel_url, sep, stream_token)
    } else {
        // Return empty — JS will call fl511DiscoverChannelUrl via fetch_url_base64 on tooltip
        String::new()
    };

    Ok(Fl511StreamResult { stream_token, stream_url })
}

// ── PennDOT / 511pa.com / arcadis-ivds.com two-step HLS token resolution ──────
//
// Flow (identical pattern to FL511 but different endpoints):
//   Step 0: GET https://www.511pa.com/map  → scrape CSRF + session cookies
//   Step 1: GET 511pa.com/Camera/GetVideoUrl?imageId=<view_id>  → { token, sourceId, systemSourceId }
//   Step 2: POST pa.arcadis-ivds.com/api/SecureTokenUri/GetSecureTokenUriBySourceId  → "?token=<hex>"
//   Result: channel_url (m3u8_url from GeoJSON) + ?token=<hex>

static PENDOT_CSRF: Mutex<Option<CsrfCache>> = Mutex::new(None);

fn pendot_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
        .connect_timeout(Duration::from_secs(8))
        .timeout(FL511_TOKEN_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

fn fetch_511pa_session(client: &reqwest::blocking::Client) -> Result<(String, String), String> {
    let cached = PENDOT_CSRF.lock().ok().and_then(|g| {
        g.as_ref()
            .filter(|c| c.fetched_at.elapsed() < FL511_CSRF_TTL)
            .map(|c| c.token.clone())
    });

    let resp = client
        .get("https://www.511pa.com/map")
        .header("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
        .header("Sec-Fetch-Dest", "document")
        .header("Sec-Fetch-Mode", "navigate")
        .header("Sec-Fetch-Site", "none")
        .send()
        .map_err(|e| format!("PA Step0 failed: {e}"))?;

    if resp.status().as_u16() >= 400 {
        return Err(format!("PA Step0 HTTP {}", resp.status().as_u16()));
    }

    let cookie_header: String = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|s| s.split(';').next())
        .collect::<Vec<_>>()
        .join("; ");

    if let Some(token) = cached {
        return Ok((token, cookie_header));
    }

    let html = resp.text().map_err(|e| format!("PA Step0 body: {e}"))?;
    let token = extract_csrf_token(&html)
        .ok_or_else(|| "PA Step0: CSRF token not found".to_string())?;

    if let Ok(mut g) = PENDOT_CSRF.lock() {
        *g = Some(CsrfCache { token: token.clone(), fetched_at: Instant::now() });
    }

    Ok((token, cookie_header))
}

fn fetch_511pa_video_url(client: &reqwest::blocking::Client, image_id: &str) -> Result<Fl511VideoInfo, String> {
    let (csrf_token, cookie_header) = fetch_511pa_session(client)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let url = format!("https://www.511pa.com/Camera/GetVideoUrl?imageId={}&_={}", image_id, ts);

    let mut req = client
        .get(&url)
        .header("Accept", "application/json, text/javascript, */*; q=0.01")
        .header("Referer", "https://www.511pa.com/map")
        .header("Origin", "https://www.511pa.com")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "same-origin")
        .header("__RequestVerificationToken", &csrf_token);

    if !cookie_header.is_empty() {
        req = req.header("Cookie", &cookie_header);
    }

    let resp = req.send().map_err(|e| format!("PA Step1 request: {e}"))?;
    let status = resp.status().as_u16();
    if status == 400 || status == 403 {
        if let Ok(mut g) = PENDOT_CSRF.lock() { *g = None; }
        return Err(format!("PA Step1 HTTP {status} (CSRF expired, cleared cache)"));
    }
    if status < 200 || status >= 400 {
        return Err(format!("PA Step1 HTTP {status}"));
    }

    let body = resp.bytes().map_err(|e| format!("PA Step1 body: {e}"))?;
    serde_json::from_slice::<Fl511VideoInfo>(&body)
        .map_err(|e| format!("PA Step1 parse: {e} body={}", String::from_utf8_lossy(&body).chars().take(200).collect::<String>()))
}

fn fetch_arcadis_token(
    client: &reqwest::blocking::Client,
    token: String,
    source_id: String,
    system_source_id: String,
    channel_url: &str,
) -> Result<String, String> {
    let csrf = PENDOT_CSRF.lock().ok().and_then(|g| {
        g.as_ref()
            .filter(|c| c.fetched_at.elapsed() < FL511_CSRF_TTL)
            .map(|c| c.token.clone())
    });

    let body = serde_json::json!({ "token": token, "sourceId": source_id, "systemSourceId": system_source_id });
    let body_str = body.to_string();

    let mut req = client
        .post("https://pa.arcadis-ivds.com/api/SecureTokenUri/GetSecureTokenUriBySourceId")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/plain, */*")
        .header("Origin", "https://www.511pa.com")
        .header("Referer", "https://www.511pa.com/")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "cross-site")
        .body(body_str);

    if let Some(ref c) = csrf {
        req = req.header("__RequestVerificationToken", c.as_str());
    }

    let resp = req.send().map_err(|e| format!("arcadis Step2 request: {e}"))?;
    let status = resp.status().as_u16();
    if status < 200 || status >= 400 {
        return Err(format!("arcadis Step2 HTTP {status}"));
    }

    let body_bytes = resp.bytes().map_err(|e| format!("arcadis Step2 body: {e}"))?;
    let token_qs: String = serde_json::from_slice(&body_bytes)
        .map_err(|e| format!("arcadis Step2 parse: {e} body={}", String::from_utf8_lossy(&body_bytes).chars().take(200).collect::<String>()))?;
    let stream_token = token_qs.trim_start_matches('?').trim_start_matches("token=").to_string();

    let sep = if channel_url.contains('?') { '&' } else { '?' };
    Ok(format!("{}{}token={}", channel_url, sep, stream_token))
}

#[tauri::command]
fn fetch_pendot_stream(image_id: String, channel_url: String) -> Result<String, String> {
    let client = pendot_client()?;

    let info = match fetch_511pa_video_url(&client, &image_id) {
        Ok(i) => i,
        Err(e) if e.contains("CSRF expired") => {
            fetch_511pa_video_url(&client, &image_id)
                .map_err(|e2| format!("PA retry failed: {e2} (original: {e})"))?
        }
        Err(e) => return Err(e),
    };

    fetch_arcadis_token(&client, info.token, info.source_id, info.system_source_id, &channel_url)
}

// ──────────────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn decode_l2(
    app: AppHandle,
    state: tauri::State<'_, Backend>,
    station: String,
    partition: String,
    timestamp: String,
    product: String,
    tilt_idx: u32,
    refresh: Option<bool>,
    palettes: Option<serde_json::Value>,
) -> Result<tauri::ipc::Response, String> {
    let pool = state.0.clone();
    let refresh_requested = refresh.unwrap_or(false);
    let station_for_sig = station.clone();
    let partition_for_sig = partition.clone();
    let timestamp_for_sig = timestamp.clone();
    let product_for_sig = product.clone();
    let palettes_for_sig = palettes.clone();
    let signature = serde_json::json!({
        "station": station_for_sig,
        "partition": partition_for_sig,
        "timestamp": timestamp_for_sig,
        "product": product_for_sig,
        "tiltIdx": tilt_idx,
        "palettes": palettes_for_sig,
    });
    tauri::async_runtime::spawn_blocking(move || {
        if !refresh_requested {
            if let Some(bytes) = read_decode_cache_bytes(&app, "l2", &signature) {
                return Ok(tauri::ipc::Response::new(bytes));
            }
        }

        let mut guard = acquire_backend(&pool);

        if let BackendState::Failed(prev_err) = &*guard {
            match spawn_backend() {
                Ok(inner) => *guard = BackendState::Ready(inner),
                Err(new_err) => return Err(format!(
                    "Backend unavailable.\nPrevious error: {}\nRestart error: {}",
                    prev_err, new_err
                )),
            }
        }

        let inner = match &mut *guard {
            BackendState::Ready(inner) => inner,
            BackendState::Failed(err) => return Err(err.clone()),
        };

        let mut req_obj = serde_json::json!({
            "cmd": "decode_l2",
            "station": station,
            "partition": partition,
            "timestamp": timestamp,
            "product": product,
            "tilt_idx": tilt_idx,
            "refresh": refresh_requested,
        });
        if let Some(p) = palettes {
            req_obj["palettes"] = p;
        }

        match request_decode_binary(inner, req_obj.clone()) {
            Ok(bytes) => {
                if let Err(err) = write_decode_cache_bytes(&app, "l2", &signature, &bytes) {
                    eprintln!("[radar] decode cache write failed: {err}");
                }
                Ok(tauri::ipc::Response::new(bytes))
            }
            Err(first_err) => {
                if !should_retry_after_backend_refresh(&first_err) {
                    return Err(first_err);
                }
                let restarted = spawn_backend().map_err(|restart_err| format!(
                    "Backend request failed: {}\nBackend restart failed: {}",
                    first_err, restart_err
                ))?;
                *inner = restarted;
                request_decode_binary(inner, req_obj)
                    .map(|bytes| {
                        if let Err(err) = write_decode_cache_bytes(&app, "l2", &signature, &bytes) {
                            eprintln!("[radar] decode cache write failed: {err}");
                        }
                        tauri::ipc::Response::new(bytes)
                    })
                    .map_err(|retry_err| format!(
                        "Backend request failed: {}\nBackend restarted but retry failed: {}",
                        first_err, retry_err
                    ))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn decode_local_file(
    app: AppHandle,
    state: tauri::State<'_, Backend>,
    path: String,
    product: String,
    tilt_idx: u32,
    palettes: Option<serde_json::Value>,
) -> Result<tauri::ipc::Response, String> {
    let pool = state.0.clone();
    let path_for_sig = path.clone();
    let product_for_sig = product.clone();
    let palettes_for_sig = palettes.clone();
    let signature = serde_json::json!({
        "file": local_file_signature(&path_for_sig),
        "product": product_for_sig,
        "tiltIdx": tilt_idx,
        "palettes": palettes_for_sig,
    });
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(bytes) = read_decode_cache_bytes(&app, "local-file", &signature) {
            return Ok(tauri::ipc::Response::new(bytes));
        }

        let mut guard = acquire_backend(&pool);

        if let BackendState::Failed(prev_err) = &*guard {
            match spawn_backend() {
                Ok(inner) => *guard = BackendState::Ready(inner),
                Err(new_err) => return Err(format!(
                    "Backend unavailable.\nPrevious error: {}\nRestart error: {}",
                    prev_err, new_err
                )),
            }
        }

        let inner = match &mut *guard {
            BackendState::Ready(inner) => inner,
            BackendState::Failed(err) => return Err(err.clone()),
        };

        let mut req_obj = serde_json::json!({
            "cmd": "decode_local_file",
            "path": path,
            "product": product,
            "tilt_idx": tilt_idx,
        });
        if let Some(p) = palettes {
            req_obj["palettes"] = p;
        }

        match request_decode_binary(inner, req_obj.clone()) {
            Ok(bytes) => {
                if let Err(err) = write_decode_cache_bytes(&app, "local-file", &signature, &bytes) {
                    eprintln!("[radar] decode cache write failed: {err}");
                }
                Ok(tauri::ipc::Response::new(bytes))
            }
            Err(first_err) => {
                if !should_restart_backend(&first_err) {
                    return Err(first_err);
                }
                let restarted = spawn_backend().map_err(|restart_err| format!(
                    "Backend request failed: {}\nBackend restart failed: {}",
                    first_err, restart_err
                ))?;
                *inner = restarted;
                request_decode_binary(inner, req_obj)
                    .map(|bytes| {
                        if let Err(err) = write_decode_cache_bytes(&app, "local-file", &signature, &bytes) {
                            eprintln!("[radar] decode cache write failed: {err}");
                        }
                        tauri::ipc::Response::new(bytes)
                    })
                    .map_err(|retry_err| format!(
                        "Backend request failed: {}\nBackend restarted but retry failed: {}",
                        first_err, retry_err
                    ))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn prepare_local_file(
    app: AppHandle,
    state: tauri::State<'_, Backend>,
    path: String,
    product: String,
    tilt_idx: u32,
    palettes: Option<serde_json::Value>,
) -> Result<tauri::ipc::Response, String> {
    let pool = state.0.clone();
    let path_for_sig = path.clone();
    let product_for_sig = product.clone();
    let palettes_for_sig = palettes.clone();
    let signature = serde_json::json!({
        "file": local_file_signature(&path_for_sig),
        "product": product_for_sig,
        "tiltIdx": tilt_idx,
        "palettes": palettes_for_sig,
    });
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(bytes) = read_decode_cache_bytes(&app, "local-file", &signature) {
            return Ok(tauri::ipc::Response::new(bytes));
        }

        let mut guard = acquire_backend(&pool);

        if let BackendState::Failed(prev_err) = &*guard {
            match spawn_backend() {
                Ok(inner) => *guard = BackendState::Ready(inner),
                Err(new_err) => return Err(format!(
                    "Backend unavailable.\nPrevious error: {}\nRestart error: {}",
                    prev_err, new_err
                )),
            }
        }

        let inner = match &mut *guard {
            BackendState::Ready(inner) => inner,
            BackendState::Failed(err) => return Err(err.clone()),
        };

        let mut req_obj = serde_json::json!({
            "cmd": "prepare_local_file",
            "path": path,
            "product": product,
            "tilt_idx": tilt_idx,
        });
        if let Some(p) = palettes {
            req_obj["palettes"] = p;
        }

        match request_decode_binary(inner, req_obj.clone()) {
            Ok(bytes) => {
                if let Err(err) = write_decode_cache_bytes(&app, "local-file", &signature, &bytes) {
                    eprintln!("[radar] decode cache write failed: {err}");
                }
                Ok(tauri::ipc::Response::new(bytes))
            }
            Err(first_err) => {
                if !should_retry_after_backend_refresh(&first_err) {
                    return Err(first_err);
                }
                let restarted = spawn_backend().map_err(|restart_err| format!(
                    "Backend request failed: {}\nBackend restart failed: {}",
                    first_err, restart_err
                ))?;
                *inner = restarted;
                request_decode_binary(inner, req_obj)
                    .map(|bytes| {
                        if let Err(err) = write_decode_cache_bytes(&app, "local-file", &signature, &bytes) {
                            eprintln!("[radar] decode cache write failed: {err}");
                        }
                        tauri::ipc::Response::new(bytes)
                    })
                    .map_err(|retry_err| format!(
                        "Backend request failed: {}\nBackend restarted but retry failed: {}",
                        first_err, retry_err
                    ))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn clear_decode_cache(app: AppHandle) -> Result<ClearDecodeCacheResponse, String> {
    tauri::async_runtime::spawn_blocking(move || clear_decode_cache_dir(&app))
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_for_app_update(app: AppHandle) -> Result<UpdateCheckResponse, String> {
    let current_version = app.package_info().version.to_string();
    let endpoint = match resolve_release_endpoint(&app) {
        Some(endpoint) => endpoint,
        None => {
            return Ok(UpdateCheckResponse {
                status: "disabled".into(),
                current_version,
                update: None,
                message: Some("Release check endpoint not configured.".into()),
            });
        }
    };

    tauri::async_runtime::spawn_blocking(move || {
        let latest_release_url = Url::parse(&endpoint)
            .map_err(|err| format!("Invalid release endpoint: {err}"))?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(APP_UPDATE_CHECK_TIMEOUT_SECS))
            .user_agent(format!("RadarApp/{current_version}"))
            .build()
            .map_err(|err| format!("Could not create release-check client: {err}"))?;
        let release = client
            .get(latest_release_url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .and_then(|resp| resp.error_for_status())
            .map_err(|err| format!("GitHub release check failed: {err}"))?
            .text()
            .map_err(|err| format!("Could not read GitHub release response: {err}"))
            .and_then(|body| {
                serde_json::from_str::<GitHubLatestRelease>(&body)
                    .map_err(|err| format!("Could not parse GitHub release response: {err}"))
            })?;

        let current = Version::parse(&current_version)
            .map_err(|err| format!("Current app version is invalid: {err}"))?;
        let latest = parse_release_version(&release.tag_name)?;

        if latest <= current {
            return Ok(UpdateCheckResponse {
                status: "upToDate".into(),
                current_version,
                update: None,
                message: Some("You already have the latest version.".into()),
            });
        }

        Ok(UpdateCheckResponse {
            status: "available".into(),
            current_version: current_version.clone(),
            update: Some(UpdateInfo {
                version: release_version_label(&release.tag_name),
                current_version,
                body: release.body.clone(),
                date: release.published_at.clone(),
                download_url: pick_release_download_url(&release),
                release_url: release.html_url,
            }),
            message: None,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn open_app_update_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|err| format!("Invalid update URL: {err}"))?;
    if parsed.scheme() != "https" {
        return Err("Only https update URLs are allowed.".into());
    }
    app.opener()
        .open_url(parsed.to_string(), None::<&str>)
        .map_err(|err| format!("Could not open update URL: {err}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Warm reqwest client + first DNS/TLS handshake to the L3 bucket so
    // initial station click is less likely to hitch on a cold connection.
    let _ = get_http_client();
    std::thread::spawn(|| {
        let _ = get_http_client()
            .get(format!("{S3_LEVEL3_LIST_URL}?list-type=2&prefix=KTLX_&max-keys=1"))
            .send();
    });

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(NwwsBridgeState::default())
        .invoke_handler(tauri::generate_handler![
            l3_list_page,
            l3_resolve_selection,
            clear_decode_cache,
            check_for_app_update,
            open_app_update_url,
            fetch_url_base64,
            fetch_fl511_stream,
            fetch_pendot_stream,
            start_nwws_bridge,
            stop_nwws_bridge,
            open_warning_dashboard
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::CloseRequested { .. }, .. }
            | tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::Destroyed, .. }
            | tauri::RunEvent::ExitRequested { .. }
            | tauri::RunEvent::Exit => {
                stop_nwws_bridge_process_for_app(app_handle);
            }
            _ => {}
        }
    });
}

