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
            + "void main() {\n"
            + "  vec2 uv = aPos * 0.5 + 0.5;\n"
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
            + "in vec2 vUv;\n"
            + "out vec4 o;\n"
            + "float s2l(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }\n"
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
            + "void main() {\n"
            + "  vec3 c = texture(uCam, vUv).rgb;\n"
            + "  vec3 outc = c * uWN;\n"
            + "  if (uWA > 0.0 || uWB > 0.0) {\n"
            + "    vec3 lin = uPreset == 1 ? vec3(s2l(c.r), s2l(c.g), s2l(c.b)) : vec3(curveAt(c.r), curveAt(c.g), curveAt(c.b));\n"
            + "    vec3 base = uM * lin;\n"
            + "    if (uWA > 0.0) outc += uWA * lutA(max(base * uGainA, 0.0));\n"
            + "    if (uWB > 0.0) outc += uWB * lutB(max(base * uGainB, 0.0));\n"
            + "  }\n"
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
        draw(lookOn, zebra);
        long now = System.currentTimeMillis();
        if (now - lastSample > 400) {
            lastSample = now;
            sample();
        }
    }

    private void draw(boolean look, boolean zeb) {
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
        GLES30.glUniform1f(GLES30.glGetUniformLocation(prog, "uTime"), (System.nanoTime() - t0) / 1e9f);
        GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4);
        GLES30.glDisableVertexAttribArray(aPos);
    }

    // カメラの素の画と、核をかけた画を小さく読んで、ページへ渡す
    private void sample() {
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo);
        GLES30.glViewport(0, 0, SAMPLE_W, SAMPLE_H);
        ByteBuffer raw = ByteBuffer.allocateDirect(SAMPLE_W * SAMPLE_H * 4);
        draw(false, false);
        GLES30.glReadPixels(0, 0, SAMPLE_W, SAMPLE_H, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, raw);
        String lookB64 = "";
        if (lutReady[0]) {
            ByteBuffer look = ByteBuffer.allocateDirect(SAMPLE_W * SAMPLE_H * 4);
            draw(true, false);
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
