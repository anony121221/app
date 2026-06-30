// ﻿// NEXRAD Level III Radar Viewer

export function buildShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const err = gl.getShaderInfoLog(shader) || 'shader compile error';
    gl.deleteShader(shader);
    throw new Error(err);
  }
  return shader;
}

export function buildProgram(gl, vertexSource, fragmentSource) {
  const vs = buildShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = buildShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const err = gl.getProgramInfoLog(program) || 'program link error';
    gl.deleteProgram(program);
    throw new Error(err);
  }
  return program;
}

// Shared WebGL program for all RadarGateLayer instances.
// Compiling the identical GLSL shaders once and reusing the program object
// across every pool layer avoids per-instance GPU driver shader-compilation
// stalls (which can take 500 ms–2 s on Windows ANGLE/D3D11).
let _rgProg = null;
let _rgProgGl = null;   // WebGL context the program was compiled for
let _rgProgAttribs = null;

// Registry of live RadarGateLayer instances keyed by layer id.
export const _radarGateLayerInstances = new Map();

// Maximum vertices to upload per render frame for the chunked GPU upload path.
// Keeps each bufferSubData call well within the 16 ms frame budget even on
// slow integrated graphics (~320 KB per chunk across all three buffers).
const _UPLOAD_CHUNK_VERTS = 55_000;
const LARGE_FRAME_IMMEDIATE_VERTEX_LIMIT = 150_000;
const RADAR_PERF_DEBUG = false;

export class RadarGateLayer {
  // u_sweep_mode: 0=normal, 1=reveal new scan (discard az>sweep_deg), 2=erase old scan (discard az<=sweep_deg)
  constructor(id) {
    this.id = id;
    this.type = 'custom';
    this.renderingMode = '2d';
    this._sweepMode = 0;

    this.map = null;
    this.gl = null;
    this.program = null;
    this.vertexCount = 0;
    this.posBuffer = null;
    this.colorBuffer = null;
    this.valBuffer = null;
    this._posByteLen = 0;
    this._colorByteLen = 0;
    this._valByteLen = 0;
    this._minValue = -9999.0;
    this._sweepDeg = 0;      // current sweep angle (0–360)
    this._stationX = 0;      // station Mercator x
    this._stationY = 0;      // station Mercator y
    this._visible = false;   // controlled by setVisible(); hidden pool layers still upload to GPU
    this._loadedData = null; // reference to the frame object currently in GPU buffers
    this._onSwap = null;     // fired once when the next back→front swap completes

    // Back buffers: new frame data uploads here while front buffers keep drawing
    // the current frame uninterrupted.  Swapped atomically when upload completes.
    this._posBufferBack   = null;
    this._colorBufferBack = null;
    this._valBufferBack   = null;
    this._posByteLenBack   = 0;
    this._colorByteLenBack = 0;
    this._valByteLenBack   = 0;
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    _radarGateLayerInstances.set(this.id, this);

    // Compile the shader program only once and share it across all pool layer
    // instances.  Recompiling identical GLSL on every RadarGateLayer creation
    // triggers a full ANGLE GLSL?HLSL?D3DCompile round-trip each time, which
    // can stall the render thread for 500 ms–2 s on Windows.
    if (!_rgProg || _rgProgGl !== gl) {
      const vertex = `
        precision highp float;
        uniform mat4 u_matrix;
        attribute highp vec2 a_pos;
        attribute vec4 a_rgba;
        attribute float a_value;
        varying vec4 v_rgba;
        varying float v_value;
        varying highp vec2 v_pos;
        void main() {
          gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
          v_rgba = a_rgba;
          v_value = a_value;
          v_pos = a_pos;
        }
      `;
      // Unified fragment shader. u_sweep_mode:
      //   0 = normal render (no mask)
      //   1 = reveal new scan — discard pixels where az > u_sweep_deg (swept area shows)
      //   2 = erase old scan  — discard pixels where az <= u_sweep_deg (swept area hidden)
      // Uses highp for azimuth math to avoid precision loss near the station.
      const fragment = `
        precision highp float;
        uniform float u_min_value;
        uniform float u_sweep_mode;
        uniform highp float u_sweep_deg;
        uniform highp vec2  u_station;
        varying vec4  v_rgba;
        varying float v_value;
        varying highp vec2  v_pos;
        void main() {
          if (u_min_value > -9990.0 && v_value < u_min_value) discard;
          if (u_sweep_mode > 0.5) {
            highp float dx = v_pos.x - u_station.x;
            if (dx > 0.5) dx -= 1.0;
            if (dx < -0.5) dx += 1.0;
            highp float dy = u_station.y - v_pos.y;
            highp float az = degrees(atan(dx, dy));
            if (az < 0.0) az += 360.0;
            if (u_sweep_mode < 1.5) {
              if (az > u_sweep_deg) discard;
            } else {
              if (az <= u_sweep_deg) discard;
            }
          }
          gl_FragColor = v_rgba;
        }
      `;
      _rgProg = buildProgram(gl, vertex, fragment);
      _rgProgGl = gl;
      _rgProgAttribs = {
        aPos:       gl.getAttribLocation(_rgProg, 'a_pos'),
        aRgba:      gl.getAttribLocation(_rgProg, 'a_rgba'),
        aValue:     gl.getAttribLocation(_rgProg, 'a_value'),
        uMatrix:    gl.getUniformLocation(_rgProg, 'u_matrix'),
        uMinValue:  gl.getUniformLocation(_rgProg, 'u_min_value'),
        uSweepMode: gl.getUniformLocation(_rgProg, 'u_sweep_mode'),
        uSweepDeg:  gl.getUniformLocation(_rgProg, 'u_sweep_deg'),
        uStation:   gl.getUniformLocation(_rgProg, 'u_station'),
      };
    }

    this.program    = _rgProg;
    this.aPos       = _rgProgAttribs.aPos;
    this.aRgba      = _rgProgAttribs.aRgba;
    this.aValue     = _rgProgAttribs.aValue;
    this.uMatrix    = _rgProgAttribs.uMatrix;
    this.uMinValue  = _rgProgAttribs.uMinValue;
    this.uSweepMode = _rgProgAttribs.uSweepMode;
    this.uSweepDeg  = _rgProgAttribs.uSweepDeg;
    this.uStation   = _rgProgAttribs.uStation;

    this.posBuffer   = gl.createBuffer();
    this.colorBuffer = gl.createBuffer();
    this.valBuffer   = gl.createBuffer();
    this._posBufferBack   = gl.createBuffer();
    this._colorBufferBack = gl.createBuffer();
    this._valBufferBack   = gl.createBuffer();
  }

  onRemove(_map, gl) {
    _radarGateLayerInstances.delete(this.id);
    if (this.posBuffer)        gl.deleteBuffer(this.posBuffer);
    if (this.colorBuffer)      gl.deleteBuffer(this.colorBuffer);
    if (this.valBuffer)        gl.deleteBuffer(this.valBuffer);
    if (this._posBufferBack)   gl.deleteBuffer(this._posBufferBack);
    if (this._colorBufferBack) gl.deleteBuffer(this._colorBufferBack);
    if (this._valBufferBack)   gl.deleteBuffer(this._valBufferBack);
    // Do NOT delete this.program — it is the shared module-level _rgProg
    // and must outlive this individual layer instance.
    this.vertexCount = 0;
  }

  setFrame(frame, onReady = null, opts = {}) {
    // If this exact frame object is already in GPU, fire callback immediately.
    if (frame && this._loadedData === frame) {
      if (this._visible) this.map?.triggerRepaint();
      if (onReady) onReady();
      return;
    }
    this._loadedData = frame || null;
    this._onSwap = null; // cancel any pending swap callback for the previous upload

    const vertexCount = Number(frame?.vertex_count || 0);
    if (!vertexCount) {
      this._pending = null;
      this.vertexCount = 0;
      this.map?.triggerRepaint();
      if (onReady) onReady();
      return;
    }

    const xy     = frame._bufXy;
    const colors = frame._bufColor;
    const v      = frame._bufVals;
    const valData = (v && v.length === vertexCount) ? v : new Float32Array(vertexCount).fill(9999.0);

    if (xy.length !== vertexCount * 2) throw new Error('Backend triangle position payload mismatch');
    if (colors.length !== vertexCount * 4) throw new Error('Backend triangle color payload mismatch');

    // When no frame is currently visible, upload immediately in a single render
    // pass so the scan appears without a multi-frame build-up delay.
    // When replacing a visible frame, use the chunked path so the old scan
    // stays smooth until the new one is fully ready.
    const forceImmediate = opts?.immediateUpload === true;
    const wantsImmediate = forceImmediate || this.vertexCount === 0;
    const _immediate = forceImmediate || (wantsImmediate && vertexCount <= LARGE_FRAME_IMMEDIATE_VERTEX_LIMIT);
    this._pending = { vertexCount, xy, colors, valData, _offset: 0, _immediate, _uploadStartMs: 0 };
    this._onSwap = onReady || null;
    this.map?.triggerRepaint();
  }

  clearFrame() {
    this._pending = null;
    this._loadedData = null;
    this._onSwap = null;
    this.vertexCount = 0;
    this.map?.triggerRepaint();
  }

  // Show or hide this layer. Hidden layers still upload pending GPU data so
  // they're instantly ready when made visible again.
  setVisible(v) {
    if (this._visible === v) return;
    this._visible = v;
    this.map?.triggerRepaint();
  }

  setSweepAngle(deg) {
    this._sweepDeg = deg;
    // no triggerRepaint here — the RAF loop already calls it
  }

  setStationPos(x, y) {
    this._stationX = x;
    this._stationY = y;
  }

  setSweepMode(mode) {
    if (this._sweepMode === mode) return;
    this._sweepMode = mode;
    this.map?.triggerRepaint();
  }

  setMinValue(v) {
    const next = (v == null) ? -9999.0 : v;
    if (this._minValue === next) return;
    this._minValue = next;
    this.map?.triggerRepaint();
  }

  isFrameReady(frame) {
    if (!frame) return false;
    return (this._loadedData === frame) && !this._pending;
  }

  // Atomically promote back buffers to front.  Called once per frame when the
  // last upload chunk completes — the old scan is visible right up to this point.
  _swapBuffers(vertexCount) {
    [this.posBuffer,   this._posBufferBack]   = [this._posBufferBack,   this.posBuffer];
    [this.colorBuffer, this._colorBufferBack] = [this._colorBufferBack, this.colorBuffer];
    [this.valBuffer,   this._valBufferBack]   = [this._valBufferBack,   this.valBuffer];
    [this._posByteLen,   this._posByteLenBack]   = [this._posByteLenBack,   this._posByteLen];
    [this._colorByteLen, this._colorByteLenBack] = [this._colorByteLenBack, this._colorByteLen];
    [this._valByteLen,   this._valByteLenBack]   = [this._valByteLenBack,   this._valByteLen];
    this.vertexCount = vertexCount;
    const cb = this._onSwap;
    this._onSwap = null;
    this.map?.triggerRepaint();
    if (cb) cb();
  }

  render(gl, matrix) {
    // Upload pending frame data to GPU in fixed-size chunks spread across
    // multiple render frames.  This prevents the monolithic gl.bufferData()
    // call from stalling the render thread for 2–3 s when a large frame
    // (~40 MB across three buffers) arrives for a new product combo.
    //
    // New data is uploaded to the BACK buffers while the FRONT buffers keep
    // serving the previous frame uninterrupted — vertexCount is never zeroed
    // during an upload.  When the last chunk lands, _swapBuffers() promotes
    // back → front atomically so the new scan appears in one render tick.
    if (this._pending) {
      const { vertexCount, xy, colors, valData, _immediate } = this._pending;
      if (!this._pending._uploadStartMs) this._pending._uploadStartMs = performance.now();
      const offset = this._pending._offset;
      const end    = Math.min(offset + _UPLOAD_CHUNK_VERTS, vertexCount);

      if (_immediate) {
        // Full immediate upload to back buffer, then swap.
        gl.bindBuffer(gl.ARRAY_BUFFER, this._posBufferBack);
        gl.bufferData(gl.ARRAY_BUFFER, xy, gl.DYNAMIC_DRAW);
        this._posByteLenBack = xy.byteLength;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._colorBufferBack);
        gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
        this._colorByteLenBack = colors.byteLength;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._valBufferBack);
        gl.bufferData(gl.ARRAY_BUFFER, valData, gl.DYNAMIC_DRAW);
        this._valByteLenBack = valData.byteLength;
        const uploadMs = performance.now() - this._pending._uploadStartMs;
        this._pending = null;
        this._swapBuffers(vertexCount);
        if (RADAR_PERF_DEBUG) {
          console.log('[RadarPerf]', {
            layer: this.id,
            vertices: vertexCount,
            uploadMs: Math.round(uploadMs),
            uploadMode: 'immediate',
            frameBytes: xy.byteLength + colors.byteLength + valData.byteLength,
          });
        }
      } else {
        if (offset === 0) {
          // First chunk: size the back buffers.  Front buffers are untouched
          // so the current scan keeps drawing without interruption.
          if (this._posByteLenBack !== xy.byteLength) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this._posBufferBack);
            gl.bufferData(gl.ARRAY_BUFFER, xy.byteLength, gl.DYNAMIC_DRAW);
            this._posByteLenBack = xy.byteLength;
          }
          if (this._colorByteLenBack !== colors.byteLength) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this._colorBufferBack);
            gl.bufferData(gl.ARRAY_BUFFER, colors.byteLength, gl.DYNAMIC_DRAW);
            this._colorByteLenBack = colors.byteLength;
          }
          if (this._valByteLenBack !== valData.byteLength) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this._valBufferBack);
            gl.bufferData(gl.ARRAY_BUFFER, valData.byteLength, gl.DYNAMIC_DRAW);
            this._valByteLenBack = valData.byteLength;
          }
        }

        // Transfer this chunk to back buffers.  Byte offsets:
        //   posBuffer   — 2 float32 per vertex → 8 bytes/vertex
        //   colorBuffer — 4 uint8  per vertex → 4 bytes/vertex
        //   valBuffer   — 1 float32 per vertex → 4 bytes/vertex
        gl.bindBuffer(gl.ARRAY_BUFFER, this._posBufferBack);
        gl.bufferSubData(gl.ARRAY_BUFFER, offset * 8, xy.subarray(offset * 2, end * 2));
        gl.bindBuffer(gl.ARRAY_BUFFER, this._colorBufferBack);
        gl.bufferSubData(gl.ARRAY_BUFFER, offset * 4, colors.subarray(offset * 4, end * 4));
        gl.bindBuffer(gl.ARRAY_BUFFER, this._valBufferBack);
        gl.bufferSubData(gl.ARRAY_BUFFER, offset * 4, valData.subarray(offset, end));

        if (end < vertexCount) {
          this._pending._offset = end;
          this.map?.triggerRepaint(); // schedule next chunk
        } else {
          // Upload complete — swap back → front.  Old scan displayed right up to this tick.
          const uploadMs = performance.now() - this._pending._uploadStartMs;
          this._pending = null;
          this._swapBuffers(vertexCount);
          if (RADAR_PERF_DEBUG) {
            console.log('[RadarPerf]', {
              layer: this.id,
              vertices: vertexCount,
              uploadMs: Math.round(uploadMs),
              uploadMode: 'chunked',
              frameBytes: xy.byteLength + colors.byteLength + valData.byteLength,
            });
          }
        }
      }
    }

    // Skip draw if this combo layer is currently hidden
    if (!this._visible) return;
    if (!this.program || this.vertexCount <= 0) return;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMatrix, false, matrix);
    gl.uniform1f(this.uMinValue, this._minValue);
    gl.uniform1f(this.uSweepMode, this._sweepMode);
    gl.uniform1f(this.uSweepDeg, this._sweepDeg);
    gl.uniform2f(this.uStation, this._stationX, this._stationY);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.enableVertexAttribArray(this.aRgba);
    gl.vertexAttribPointer(this.aRgba, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.valBuffer);
    gl.enableVertexAttribArray(this.aValue);
    gl.vertexAttribPointer(this.aValue, 1, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
  }
}

// -- Sweep Line Layer (white rotating indicator) -------------------------------
// Reads shared sweep state — angle is driven by the sweepTick() RAF loop.
export class SweepLayer {
  constructor(id, options = {}) {
    this.id = id;
    this.type = 'custom';
    this.renderingMode = '2d';
    this._getSweepState = typeof options.getSweepState === 'function'
      ? options.getSweepState
      : () => ({ active: false, waiting: false, angleDeg: 0 });
    this.map = null;
    this.gl = null;
    this.program = null;
    this.posBuffer = null;
    this.alphaBuffer = null;
    this.stationX = 0;
    this.stationY = 0;
    this.meterUnit = 1;
    this._hasStation = false;
    this._trailDeg = 28;
    this._trailSegs = 20;
    this._rangeMeters = 260000;
    this._lineSegs = 3;
    this._posData = new Float32Array((this._lineSegs + 2) * 2);
    this._alphaData = new Float32Array(this._lineSegs + 2);
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    const vert = `
      precision mediump float;
      uniform mat4 u_matrix;
      attribute vec2 a_pos;
      attribute float a_alpha;
      varying float v_alpha;
      void main() {
        gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
        v_alpha = a_alpha;
      }
    `;
    const frag = `
      precision mediump float;
      varying float v_alpha;
      void main() {
        gl_FragColor = vec4(1.0, 1.0, 1.0, v_alpha);
      }
    `;
    this.program  = buildProgram(gl, vert, frag);
    this.aPos     = gl.getAttribLocation(this.program, 'a_pos');
    this.aAlpha   = gl.getAttribLocation(this.program, 'a_alpha');
    this.uMatrix  = gl.getUniformLocation(this.program, 'u_matrix');
    this.posBuffer   = gl.createBuffer();
    this.alphaBuffer = gl.createBuffer();
  }

  onRemove(_map, gl) {
    if (this.posBuffer)   gl.deleteBuffer(this.posBuffer);
    if (this.alphaBuffer) gl.deleteBuffer(this.alphaBuffer);
    if (this.program)     gl.deleteProgram(this.program);
  }

  setStation(lat, lon) {
    const merc = mapboxgl.MercatorCoordinate.fromLngLat([lon, lat]);
    this.stationX  = merc.x;
    this.stationY  = merc.y;
    this.meterUnit = merc.meterInMercatorCoordinateUnits();
    this._hasStation = true;
  }

  render(gl, matrix) {
    const _state = this._getSweepState() || {};
    if (!_state.active || _state.waiting || !this._hasStation || !this.program) return;

    const cx    = this.stationX;
    const cy    = this.stationY;
    const r     = this._rangeMeters * this.meterUnit;
    const angle = Number.isFinite(Number(_state.angleDeg)) ? Number(_state.angleDeg) : 0;

    // Just the bright sweep line — a very tight 1.5° fan so it's visible as a line
    const segs = this._lineSegs;
    const posData = this._posData;
    const alphaData = this._alphaData;
    posData[0] = cx; posData[1] = cy; alphaData[0] = 0.0;
    for (let i = 0; i <= segs; i++) {
      const t   = i / segs;
      const rad = ((angle - 1.5 + t * 1.5) * Math.PI) / 180;
      const idx = i + 1;
      posData[idx * 2]     = cx + Math.sin(rad) * r;
      posData[idx * 2 + 1] = cy - Math.cos(rad) * r;
      alphaData[idx] = 0.9 + t * 0.1;
    }

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMatrix, false, matrix);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, posData, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.alphaBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, alphaData, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aAlpha);
    gl.vertexAttribPointer(this.aAlpha, 1, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, segs + 2);
  }
}
