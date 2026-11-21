package jp.takumi.sunglasses;

import android.graphics.SurfaceTexture;
import android.opengl.GLES11Ext;
import android.opengl.GLES30;
import android.opengl.GLSurfaceView;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.ShortBuffer;

import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/**
 * 撮る画面の画を描く（2026-11-05）。カメラの画に、核の色の対応表をかけて出す。
 * 色の流れはページの画の処理（web/engine）と同じ: 画の値 → 光の量 → AP1 → 露光量 → ACEScct → 核の対応表。
 * 対応表は 2 つまで持ち、カメラの素の画と合わせて 3 つを重み（Sun Level）で混ぜる（窓口 版 3）。
 * 撮る画面の画の値は、カメラに sRGB の素直な曲線を頼めたときはその逆、頼めなかったときは JPEG を戻す曲線で光の量に戻す。
 * 白く飛びそうな所には、斜めの縞を出す。0.4 秒ごとに小さな画をページへ渡す（露光量の合わせと明るさの山に使う）。
 */
final class PreviewRenderer implements GLSurfaceView.Renderer, SurfaceTexture.OnFrameAvailableListener {
    interface Host {
        void onSurfaceReady(SurfaceTexture st);

        void onSample(String json);
    }

    private static final String VS = "#version 300 es\n"
            + "in vec2 aPos;\n"
            + "uniform mat4 uTex;\n"
            + "out vec2 vUv;\n"
            + "out vec2 vS;\n"
            + "void main() {\n"
            + "  vec2 uv = aPos * 0.5 + 0.5;\n"
            + "  vS = uv;\n"
            + "  vUv = (uTex * vec4(uv, 0.0, 1.0)).xy;\n"
            + "  gl_Position = vec4(aPos, 0.0, 1.0);\n"
            + "}\n";
    private static final String FS = "#version 300 es\n"
            + "#extension GL_OES_EGL_image_external_essl3 : require\n"
            + "precision highp float;\n"
            + "precision highp sampler3D;\n"
            + "uniform samplerExternalOES uCam;\n"
            + "uniform sampler3D uLutA;\n"
            + "uniform sampler3D uLutB;\n"
            + "uniform sampler2D uCurve;\n"
            + "uniform int uPreset;\n"
            + "uniform int uZebra;\n"
            + "uniform mat3 uM;\n"
            + "uniform float uGainA;\n"
            + "uniform float uGainB;\n"
            + "uniform float uWN;\n"
            + "uniform float uWA;\n"
            + "uniform float uWB;\n"
            + "uniform vec3 uLoA;\n"
            + "uniform vec3 uHiA;\n"
            + "uniform float uNA;\n"
            + "uniform vec3 uLoB;\n"
            + "uniform vec3 uHiB;\n"
            + "uniform float uNB;\n"
            + "uniform float uTime;\n"
            // 2026-11-21 ピクセルアートとゲームの色味（ページ側 web/engine/shaders.js の FS_FINAL と同じ式）。
            // uCells = 枠に並ぶマスの数（横・縦。0 で無し）、uGame = ゲームの色味（0〜2）。マスの色はマスの真ん中の 1 点
            + "uniform mat4 uTex;\n"
            + "uniform vec2 uCells;\n"
            + "uniform float uGame;\n"
            + "in vec2 vUv;\n"
            + "in vec2 vS;\n"
            + "out vec4 o;\n"
            + "float s2l(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }\n"
            + "float l2s(float c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055; }\n"
            + "const float GT_X[9] = float[9](0.0, 0.10, 0.17, 0.22, 0.41, 0.54, 0.65, 0.89, 1.0);\n"
            + "const float GT_Y[9] = float[9](0.0, 0.0, 0.03, 0.08, 0.29, 0.45, 0.62, 0.86, 1.0);\n"
            + "const float GC_X[9] = float[9](0.0, 0.01, 0.025, 0.05, 0.09, 0.11, 0.15, 0.25, 0.4);\n"
            + "const float GC_Y[9] = float[9](0.0, 0.017, 0.048, 0.09, 0.135, 0.165, 0.21, 0.29, 0.4);\n"
            + "float ip9(float x, float xs[9], float ys[9]) {\n"
            + "  if (x <= xs[0]) return ys[0];\n"
            + "  for (int i = 1; i < 9; i++) if (x <= xs[i]) return mix(ys[i - 1], ys[i], (x - xs[i - 1]) / (xs[i] - xs[i - 1]));\n"
            + "  return ys[8];\n"
            + "}\n"
            + "vec3 okLin(float L, float a, float b) {\n"
            + "  float l = L + 0.3963377774 * a + 0.2158037573 * b, m = L - 0.1055613458 * a - 0.0638541728 * b, s = L - 0.0894841775 * a - 1.2914855480 * b;\n"
            + "  l = l * l * l; m = m * m * m; s = s * s * s;\n"
            + "  return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);\n"
            + "}\n"
            + "bool okIn(vec3 r) { return all(greaterThanEqual(r, vec3(-1e-4))) && all(lessThanEqual(r, vec3(1.0001))); }\n"
            + "vec3 gameColor(vec3 c, float s) {\n"
            + "  vec3 q = vec3(s2l(c.r), s2l(c.g), s2l(c.b));\n"
            + "  float l = pow(0.4122214708 * q.r + 0.5363325363 * q.g + 0.0514459929 * q.b, 1.0 / 3.0);\n"
            + "  float m = pow(0.2119034982 * q.r + 0.6806995451 * q.g + 0.1073969566 * q.b, 1.0 / 3.0);\n"
            + "  float t = pow(0.0883024619 * q.r + 0.2817188376 * q.g + 0.6299787005 * q.b, 1.0 / 3.0);\n"
            + "  float L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * t;\n"
            + "  float a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * t;\n"
            + "  float b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * t;\n"
            + "  L = clamp(L + s * (ip9(L, GT_X, GT_Y) - L), 0.0, 1.0);\n"
            + "  float ch = length(vec2(a, b));\n"
            + "  if (ch > 1e-6) {\n"
            + "    float w = L < 0.1 ? mix(0.2, 0.3, L / 0.1) : (L < 0.3 ? mix(0.3, 1.0, (L - 0.1) / 0.2) : 1.0);\n"
            + "    float k = max(ch + s * w * (ip9(ch, GC_X, GC_Y) - ch), 0.0) / ch;\n"
            + "    a *= k; b *= k;\n"
            + "  }\n"
            + "  vec3 r = okLin(L, a, b);\n"
            + "  if (!okIn(r)) {\n"
            + "    float lo = 0.0, hi = 1.0;\n"
            + "    for (int i = 0; i < 10; i++) { float h = 0.5 * (lo + hi); if (okIn(okLin(L, a * h, b * h))) lo = h; else hi = h; }\n"
            + "    r = okLin(L, a * lo, b * lo);\n"
            + "  }\n"
            + "  r = clamp(r, 0.0, 1.0);\n"
            + "  return clamp(vec3(l2s(r.r), l2s(r.g), l2s(r.b)), 0.0, 1.0);\n"
            + "}\n"
            + "float curveAt(float x) {\n"
            + "  float p = clamp(x, 0.0, 1.0) * 1023.0; int i = min(int(p), 1022);\n"
            + "  return mix(texelFetch(uCurve, ivec2(i, 0), 0).r, texelFetch(uCurve, ivec2(i + 1, 0), 0).r, p - float(i));\n"
            + "}\n"
            + "float cct(float v) { return v <= 0.0078125 ? 10.5402377416545 * v + 0.0729055341958355 : (log2(v) + 9.72) / 17.52; }\n"
            + "vec3 lutA(vec3 a) {\n"
            + "  vec3 t = clamp((vec3(cct(a.r), cct(a.g), cct(a.b)) - uLoA) / (uHiA - uLoA), 0.0, 1.0);\n"
            + "  return texture(uLutA, (t * (uNA - 1.0) + 0.5) / uNA).rgb;\n"
            + "}\n"
            + "vec3 lutB(vec3 a) {\n"
            + "  vec3 t = clamp((vec3(cct(a.r), cct(a.g), cct(a.b)) - uLoB) / (uHiB - uLoB), 0.0, 1.0);\n"
            + "  return texture(uLutB, (t * (uNB - 1.0) + 0.5) / uNB).rgb;\n"
            + "}\n"
            + "// マスの線（2026-11-21）。GTA6 のお手本 9 枚の、色が平らなマスを測った形。マスの幅を 12 に分けた位置ごとの、暗くなる割合。\n"
            + "// PL_X = 左右の端の縦の線、PL_Y = 上下のなだらかな山（マスの真ん中の列だけ。PL_M がその効き方）。線は暗い所ほど濃く、山は暗い所では弱い\n"
            + "const float PL_X[12] = float[12](0.032, 0.019, 0.004, 0.0, 0.0, 0.0, 0.0, 0.0, 0.002, 0.009, 0.022, 0.032);\n"
            + "const float PL_M[12] = float[12](0.0, 0.2, 0.5, 0.8, 1.0, 1.0, 1.0, 1.0, 0.7, 0.45, 0.2, 0.0);\n"
            + "const float PL_Y[12] = float[12](0.0175, 0.0148, 0.0125, 0.0110, 0.0095, 0.0060, 0.0005, -0.0040, -0.0018, 0.0064, 0.0160, 0.0215);\n"
            + "float pl12(float t, float T[12]) {\n"
            + "  float x = fract(t) * 12.0 - 0.5, i0 = floor(x);\n"
            + "  int a = int(i0 + 12.0) % 12, b = (a + 1) % 12;\n"
            + "  return mix(T[a], T[b], x - i0);\n"
            + "}\n"
            + "// 画面の 1 画素がマスのどれだけに当たるか（w）の幅でならす（マスが小さい時に、線がちらつかないように）\n"
            + "float plAvg(float t, float w, float T[12]) {\n"
            + "  w = min(w, 1.0);\n"
            + "  float s = 0.0;\n"
            + "  for (int k = 0; k < 6; k++) s += pl12(t + w * ((float(k) + 0.5) / 6.0 - 0.5), T);\n"
            + "  return s / 6.0;\n"
            + "}\n"
            + "vec3 cellLine(vec3 c, vec2 p, vec2 w, float s) {\n"
            + "  float Y = dot(c, vec3(0.2126, 0.7152, 0.0722));\n"
            + "  float line = plAvg(p.x, w.x, PL_X) * (0.052 - 0.030 * Y) / 0.032;\n"
            + "  float hump = plAvg(p.y, w.y, PL_Y) * plAvg(p.x, w.x, PL_M) * smoothstep(0.08, 0.4, Y);\n"
            + "  return c * clamp(1.0 - s * (line + hump), 0.0, 1.5);\n"
            + "}\n"
            + "void main() {\n"
            + "  vec2 uv = vUv;\n"
            + "  if (uCells.x > 0.0) uv = (uTex * vec4((floor(vS * uCells) + 0.5) / uCells, 0.0, 1.0)).xy;\n"
            + "  vec3 c = texture(uCam, uv).rgb;\n"
            + "  vec3 outc = c * uWN;\n"
            + "  if (uWA > 0.0 || uWB > 0.0) {\n"
            + "    vec3 lin = uPreset == 1 ? vec3(s2l(c.r), s2l(c.g), s2l(c.b)) : vec3(curveAt(c.r), curveAt(c.g), curveAt(c.b));\n"
            + "    vec3 base = uM * lin;\n"
            + "    if (uWA > 0.0) outc += uWA * lutA(max(base * uGainA, 0.0));\n"
            + "    if (uWB > 0.0) outc += uWB * lutB(max(base * uGainB, 0.0));\n"
            + "  }\n"
            + "  if (uGame > 0.0) outc = gameColor(clamp(outc, 0.0, 1.0), uGame);\n"
            + "  if (uCells.x > 0.0) outc = cellLine(clamp(outc, 0.0, 1.0), vS * uCells, fwidth(vS * uCells), 1.0);\n"
            + "  if (uZebra == 1 && max(c.r, max(c.g, c.b)) > 0.985 && mod(gl_FragCoord.x + gl_FragCoord.y + uTime * 24.0, 14.0) < 7.0)\n"
            + "    outc = vec3(1.0, 0.32, 0.25);\n"
            + "  o = vec4(outc, 1.0);\n"
            + "}\n";

    private static final int SAMPLE_W = 64, SAMPLE_H = 48;
    private final GLSurfaceView view;
    private final Host host;
    private int prog, oesTex, curveTex, fbo, fboTex;
    private final int[] lutTex = new int[2];
    private SurfaceTexture st;
    private final float[] texMatrix = new float[16];
    private final FloatBuffer quad;
    private int surfW, surfH;
    private long lastSample;
    private final long t0 = System.nanoTime();

    // UI の流れから受け取る設定（描く流れで読む）
    private final ShortBuffer[] pendingLut = new ShortBuffer[2];
    private final int[] lutN = {2, 2};
    private final float[][] lutLo = {{0, 0, 0}, {0, 0, 0}}, lutHi = {{1, 1, 1}, {1, 1, 1}};
    private final boolean[] lutReady = new boolean[2];
    private volatile float[] pendingCurve;
    private volatile float[] matrix = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    private volatile boolean lookOn = true, zebra = true, preset = false;
    private volatile float gainA = 1f, gainB = 1f, wN = 0f, wA = 1f, wB = 0f;
    private volatile float pixN = 0f, game = 0f;  // ピクセルアート: 枠の短い辺に並ぶマスの数（0 で無し）と、ゲームの色味（0〜2）
    private volatile int rx, ry, rw = 1, rh = 1;  // 画を出す枠（ビューの画素、左上が原点）

    PreviewRenderer(GLSurfaceView view, Host host) {
        this.view = view;
        this.host = host;
        quad = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        quad.put(new float[]{-1, -1, 1, -1, -1, 1, 1, 1}).position(0);
    }

    // ---- 設定（どの流れから呼んでもよい）----
    void setLut(int slot, String base64Half, int n, float[] lo, float[] hi) {
        if (slot < 0 || slot > 1) return;
        byte[] b = Base64.decode(base64Half, Base64.DEFAULT);
        ByteBuffer bb = ByteBuffer.allocateDirect(b.length).order(ByteOrder.LITTLE_ENDIAN);
        bb.put(b);
        bb.position(0);
        synchronized (pendingLut) {
            lutN[slot] = n;
            lutLo[slot] = lo;
            lutHi[slot] = hi;
            pendingLut[slot] = bb.asShortBuffer();
        }
        view.requestRender();
    }

    void setParams(float[] m, float[] curve) {
        if (m != null && m.length == 9) matrix = m;
        if (curve != null && curve.length >= 2) pendingCurve = curve;
        view.requestRender();
    }

    void setGains(float a, float b) {
        gainA = a;
        gainB = b;
    }

    // ピクセルアート: 枠の短い辺に並ぶマスの数（0 で無し）と、ゲームの色味（0〜2）
    void setPixel(float n, float g) {
        pixN = n;
        game = g;
        view.requestRender();
    }

    // 重み: カメラの素の画・対応表 1・対応表 2（足して 1）
    void setWeights(float n, float a, float b) {
        wN = n;
        wA = a;
        wB = b;
        view.requestRender();
    }

    void setLookOn(boolean on) {
        lookOn = on;
        view.requestRender();
    }

    void setZebra(boolean on) {
        zebra = on;
        view.requestRender();
    }

    void setPreset(boolean on) {
        preset = on;
    }

    void setRect(int x, int y, int w, int h) {
        rx = x;
        ry = y;
        rw = Math.max(1, w);
        rh = Math.max(1, h);
        view.requestRender();
    }

    // ---- GL の流れ ----
    @Override
    public void onSurfaceCreated(GL10 unused, EGLConfig config) {
        prog = program(VS, FS);
        int[] t = new int[1];
        GLES30.glGenTextures(1, t, 0);
        oesTex = t[0];
        GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex);
        GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR);
        GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR);
        GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE);
        GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE);
        // 描き先が作り直されると対応表も消えるので、受け取り直したものから入れ直す
        lutTex[0] = lutTex[1] = 0;
        lutReady[0] = lutReady[1] = false;
        curveTex = 0;
        GLES30.glGenTextures(1, t, 0);
        fboTex = t[0];
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, fboTex);
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, SAMPLE_W, SAMPLE_H, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null);
        int[] f = new int[1];
        GLES30.glGenFramebuffers(1, f, 0);
        fbo = f[0];
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo);
        GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, fboTex, 0);
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
        if (pendingCurve == null) pendingCurve = new float[]{0, 1};
        st = new SurfaceTexture(oesTex);
        st.setOnFrameAvailableListener(this);
        host.onSurfaceReady(st);
    }

    @Override
    public void onSurfaceChanged(GL10 unused, int w, int h) {
        surfW = w;
        surfH = h;
    }

    @Override
    public void onFrameAvailable(SurfaceTexture s) {
        view.requestRender();
    }

    @Override
    public void onDrawFrame(GL10 unused) {
        uploadPending();
        if (st != null) {
            try {
                st.updateTexImage();
                st.getTransformMatrix(texMatrix);
            } catch (Exception ignored) {
                // カメラが止まった直後は読めないことがある
            }
        }
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
        GLES30.glViewport(0, 0, surfW, surfH);
        GLES30.glClearColor(0, 0, 0, 1);
        GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT);
        GLES30.glViewport(rx, surfH - ry - rh, rw, rh);
        draw(lookOn, zebra, true);
        long now = System.currentTimeMillis();
        if (now - lastSample > 400) {
            lastSample = now;
            sample();
        }
    }

    // fx: ピクセルアートとゲームの色味をかけるか（画面に出すときだけ。明るさを測るための小さい画にはかけない）
    private void draw(boolean look, boolean zeb, boolean fx) {
        // 対応表がまだ無いときと、素の画を見たいときは、カメラの画だけ
        float a = look && lutReady[0] ? wA : 0f, b = look && lutReady[1] ? wB : 0f;
        float n = look ? wN : 1f;
        if (a + b + n < 1e-3) n = 1f;
        GLES30.glUseProgram(prog);
        int aPos = GLES30.glGetAttribLocation(prog, "aPos");
        GLES30.glEnableVertexAttribArray(aPos);
        GLES30.glVertexAttribPointer(aPos, 2, GLES30.GL_FLOAT, false, 0, quad);
        GLES30.glUniformMatrix4fv(GLES30.glGetUniformLocation(prog, "uTex"), 1, false, texMatrix, 0);
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0);
        GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(prog, "uCam"), 0);
        GLES30.glActiveTexture(GLES30.GL_TEXTURE1);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, lutTex[0]);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(prog, "uLutA"), 1);
        GLES30.glActiveTexture(GLES30.GL_TEXTURE3);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, lutTex[1] != 0 ? lutTex[1] : lutTex[0]);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(prog, "uLutB"), 3);
        GLES30.glActiveTexture(GLES30.GL_TEXTURE2);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, curveTex);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(prog, "uCurve"), 2);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(prog, "uPreset"), preset ? 1 : 0);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(prog, "uZebra"), zeb ? 1 : 0);
        GLES30.glUniformMatrix3fv(GLES30.glGetUniformLocation(prog, "uM"), 1, true, matrix, 0);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(prog, "uGainA"), gainA);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(prog, "uGainB"), gainB);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(prog, "uWN"), n);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(prog, "uWA"), a);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(prog, "uWB"), b);
        GLES30.glUniform3fv(GLES30.glGetUniformLocation(prog, "uLoA"), 1, lutLo[0], 0);
        GLES30.glUniform3fv(GLES30.glGetUniformLocation(prog, "uHiA"), 1, lutHi[0], 0);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(prog, "uNA"), Math.max(2, lutN[0]));
        GLES30.glUniform3fv(GLES30.glGetUniformLocation(prog, "uLoB"), 1, lutLo[1], 0);
        GLES30.glUniform3fv(GLES30.glGetUniformLocation(prog, "uHiB"), 1, lutHi[1], 0);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(prog, "uNB"), Math.max(2, lutN[1]));
        boolean px = fx && look && pixN > 0f;
        float side = px ? Math.min(rw, rh) / pixN : 1f;
        GLES30.glUniform2f(GLES30.glGetUniformLocation(prog, "uCells"), px ? rw / side : 0f, px ? rh / side : 0f);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(prog, "uGame"), fx && look ? game : 0f);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(prog, "uTime"), (System.nanoTime() - t0) / 1e9f);
        GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4);
        GLES30.glDisableVertexAttribArray(aPos);
    }

    // カメラの素の画と、核をかけた画を小さく読んで、ページへ渡す
    private void sample() {
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo);
        GLES30.glViewport(0, 0, SAMPLE_W, SAMPLE_H);
        ByteBuffer raw = ByteBuffer.allocateDirect(SAMPLE_W * SAMPLE_H * 4);
        draw(false, false, false);
        GLES30.glReadPixels(0, 0, SAMPLE_W, SAMPLE_H, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, raw);
        String lookB64 = "";
        if (lutReady[0]) {
            ByteBuffer look = ByteBuffer.allocateDirect(SAMPLE_W * SAMPLE_H * 4);
            draw(true, false, false);
            GLES30.glReadPixels(0, 0, SAMPLE_W, SAMPLE_H, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, look);
            lookB64 = b64(look);
        }
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
        try {
            JSONObject o = new JSONObject();
            o.put("w", SAMPLE_W);
            o.put("h", SAMPLE_H);
            o.put("raw", b64(raw));
            o.put("look", lookB64);
            o.put("preset", preset);
            host.onSample(o.toString());
        } catch (Exception ignored) {
            // 渡せなくても撮る画面は動く
        }
    }

    private static String b64(ByteBuffer b) {
        byte[] a = new byte[b.capacity()];
        b.position(0);
        b.get(a);
        return Base64.encodeToString(a, Base64.NO_WRAP);
    }

    private void uploadPending() {
        for (int slot = 0; slot < 2; slot++) {
            ShortBuffer lut;
            int n;
            synchronized (pendingLut) {
                lut = pendingLut[slot];
                n = lutN[slot];
                pendingLut[slot] = null;
            }
            if (lut == null) continue;
            if (lutTex[slot] == 0) {
                int[] t = new int[1];
                GLES30.glGenTextures(1, t, 0);
                lutTex[slot] = t[0];
            }
            GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, lutTex[slot]);
            GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 2);
            GLES30.glTexImage3D(GLES30.GL_TEXTURE_3D, 0, GLES30.GL_RGB16F, n, n, n, 0, GLES30.GL_RGB, GLES30.GL_HALF_FLOAT, lut);
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR);
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR);
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE);
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE);
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_R, GLES30.GL_CLAMP_TO_EDGE);
            lutReady[slot] = true;
        }
        float[] curve = pendingCurve;
        if (curve != null) {
            pendingCurve = null;
            if (curveTex == 0) {
                int[] t = new int[1];
                GLES30.glGenTextures(1, t, 0);
                curveTex = t[0];
            }
            FloatBuffer fb = ByteBuffer.allocateDirect(curve.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
            fb.put(curve).position(0);
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, curveTex);
            GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 4);
            GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_R32F, curve.length, 1, 0, GLES30.GL_RED, GLES30.GL_FLOAT, fb);
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_NEAREST);
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_NEAREST);
        }
    }

    void release() {
        if (st != null) {
            st.release();
            st = null;
        }
    }

    private static int program(String vs, String fs) {
        int v = shader(GLES30.GL_VERTEX_SHADER, vs), f = shader(GLES30.GL_FRAGMENT_SHADER, fs);
        int p = GLES30.glCreateProgram();
        GLES30.glAttachShader(p, v);
        GLES30.glAttachShader(p, f);
        GLES30.glLinkProgram(p);
        int[] ok = new int[1];
        GLES30.glGetProgramiv(p, GLES30.GL_LINK_STATUS, ok, 0);
        if (ok[0] == 0) throw new RuntimeException("撮る画面の式をつなげません: " + GLES30.glGetProgramInfoLog(p));
        return p;
    }

    private static int shader(int type, String src) {
        int s = GLES30.glCreateShader(type);
        GLES30.glShaderSource(s, src);
        GLES30.glCompileShader(s);
        int[] ok = new int[1];
        GLES30.glGetShaderiv(s, GLES30.GL_COMPILE_STATUS, ok, 0);
        if (ok[0] == 0) throw new RuntimeException("撮る画面の式を組み立てられません: " + GLES30.glGetShaderInfoLog(s));
        return s;
    }
}
