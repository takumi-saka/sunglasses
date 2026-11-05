package jp.takumi.sunglasses;

import android.annotation.SuppressLint;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.DngCreator;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.MeteringRectangle;
import android.hardware.camera2.params.ColorSpaceTransform;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.RggbChannelVector;
import android.hardware.camera2.params.SessionConfiguration;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.ExifInterface;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaActionSound;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.HandlerThread;
import android.provider.MediaStore;
import android.util.Log;
import android.util.Range;
import android.util.Rational;
import android.util.Size;
import android.util.SizeF;
import android.view.Surface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executor;

/**
 * サングラスで撮る（2026-11-05）。スマホの Camera2 で、1 枚撮りの生の RAW（RAW_SENSOR）を撮り、DNG にして
 * DCIM/Sunglasses に保存する。撮る画面の画は PreviewRenderer が描く。
 * DNG には、撮影の情報と、レンズの明るさむらの補正の表（取れれば）が入る（DngCreator が書く）。
 * ページへは、イベント（sunglasses:camera・sunglasses:captured）で知らせる。
 */
final class CameraController {
    interface Events {
        void emit(String name, String json);
    }

    private static final String TAG = "SunglassesCamera";
    private final Context ctx;
    private final Events events;
    private final CameraManager mgr;
    private HandlerThread thread;
    private Handler bg;
    private CameraDevice device;
    private CameraCaptureSession session;
    private CameraCharacteristics chars;
    private ImageReader rawReader;
    private Surface previewSurface;
    private SurfaceTexture surfaceTexture;
    private CaptureRequest.Builder preview;
    private String cameraId, wantId;
    private Size rawSize, previewSize;
    private boolean shadingMap, presetSrgb, afContinuous, opening;
    private float evStep = 1f / 3f;
    private int evMin, evMax, evIndex;
    private boolean locked;
    // 手動の設定（null は自動）。版 3
    private Integer manIso;
    private Long manExp;
    private Float manFocus;
    private String afMode = "continuous", wbMode = "auto";
    private float[] wbGains;
    private boolean manualSensor, manualPost;
    private final Map<Long, Image> images = new HashMap<>();
    private final Map<Long, TotalCaptureResult> results = new HashMap<>();
    private volatile int deviceRotation;
    private volatile boolean sound = true;
    private final MediaActionSound shutter = new MediaActionSound();
    private long lastInfo;
    private final PreviewRenderer renderer;

    CameraController(Context ctx, PreviewRenderer renderer, Events events) {
        this.ctx = ctx;
        this.renderer = renderer;
        this.events = events;
        this.mgr = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
        shutter.load(MediaActionSound.SHUTTER_CLICK);
    }

    boolean isOpen() {
        return device != null || opening;
    }

    void setDeviceRotation(int deg) {
        deviceRotation = deg;
    }

    // ---- 使えるカメラを調べる（後ろのカメラ。RAW が撮れるか・画素数・焦点距離）----
    String info() {
        JSONObject out = new JSONObject();
        JSONArray cams = new JSONArray();
        try {
            for (String id : mgr.getCameraIdList()) {
                CameraCharacteristics c = mgr.getCameraCharacteristics(id);
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                if (facing == null || facing != CameraCharacteristics.LENS_FACING_BACK) continue;
                JSONObject o = new JSONObject();
                int[] caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
                StreamConfigurationMap map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                Size[] raws = map == null ? null : map.getOutputSizes(ImageFormat.RAW_SENSOR);
                o.put("id", id);
                o.put("raw", has(caps, CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_RAW) && raws != null && raws.length > 0);
                JSONArray rs = new JSONArray();
                if (raws != null) for (Size s : raws) rs.put(s.getWidth() + "x" + s.getHeight());
                o.put("rawSizes", rs);
                o.put("logical", has(caps, CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA));
                o.put("ultraHighRes", android.os.Build.VERSION.SDK_INT >= 31
                        && has(caps, CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_ULTRA_HIGH_RESOLUTION_SENSOR));
                o.put("physical", new JSONArray(new ArrayList<>(c.getPhysicalCameraIds())));
                Integer level = c.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL);
                o.put("level", level == null ? -1 : level);
                float[] fl = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
                SizeF ps = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
                if (fl != null && fl.length > 0) {
                    o.put("focal", fl[0]);
                    if (ps != null) o.put("eq35", Math.round(fl[0] * 43.27 / Math.hypot(ps.getWidth(), ps.getHeight())));
                }
                int[] tm = c.get(CameraCharacteristics.TONEMAP_AVAILABLE_TONE_MAP_MODES);
                o.put("presetCurve", has(tm, CameraMetadata.TONEMAP_MODE_PRESET_CURVE));
                int[] sm = c.get(CameraCharacteristics.STATISTICS_INFO_AVAILABLE_LENS_SHADING_MAP_MODES);
                o.put("shadingMap", has(sm, CameraMetadata.STATISTICS_LENS_SHADING_MAP_MODE_ON));
                o.put("manualSensor", has(caps, CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR));
                o.put("manualPost", has(caps, CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_POST_PROCESSING));
                Range<Integer> iso = c.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
                if (iso != null) o.put("iso", new JSONArray(new int[]{iso.getLower(), iso.getUpper()}));
                Range<Long> exp = c.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
                if (exp != null) o.put("exposure", new JSONArray(new double[]{exp.getLower() / 1e9, exp.getUpper() / 1e9}));
                Float minFocus = c.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
                o.put("minFocus", minFocus == null ? 0 : minFocus);
                int[] awb = c.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES);
                o.put("awbModes", new JSONArray(awb == null ? new int[0] : awb));
                int[] afm = c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
                o.put("afModes", new JSONArray(afm == null ? new int[0] : afm));
                o.put("colorTransform1", matrix(c.get(CameraCharacteristics.SENSOR_COLOR_TRANSFORM1)));
                o.put("colorTransform2", matrix(c.get(CameraCharacteristics.SENSOR_COLOR_TRANSFORM2)));
                o.put("forwardMatrix1", matrix(c.get(CameraCharacteristics.SENSOR_FORWARD_MATRIX1)));
                o.put("forwardMatrix2", matrix(c.get(CameraCharacteristics.SENSOR_FORWARD_MATRIX2)));
                o.put("calibration1", matrix(c.get(CameraCharacteristics.SENSOR_CALIBRATION_TRANSFORM1)));
                o.put("calibration2", matrix(c.get(CameraCharacteristics.SENSOR_CALIBRATION_TRANSFORM2)));
                Integer il1 = c.get(CameraCharacteristics.SENSOR_REFERENCE_ILLUMINANT1);
                Byte il2 = c.get(CameraCharacteristics.SENSOR_REFERENCE_ILLUMINANT2);
                o.put("illuminant1", il1 == null ? 0 : il1);
                o.put("illuminant2", il2 == null ? 0 : il2);
                cams.put(o);
            }
            out.put("cameras", cams);
        } catch (Exception e) {
            try {
                out.put("error", String.valueOf(e));
            } catch (Exception ignored) {
                // 書けなければ空
            }
        }
        return out.toString();
    }

    private static JSONArray matrix(ColorSpaceTransform t) {
        JSONArray a = new JSONArray();
        if (t == null) return a;
        for (int r = 0; r < 3; r++) {
            for (int c = 0; c < 3; c++) {
                try {
                    a.put(t.getElement(c, r).doubleValue());
                } catch (Exception ignored) {
                    // 読めない値は飛ばす
                }
            }
        }
        return a;
    }

    private static boolean has(int[] a, int v) {
        if (a == null) return false;
        for (int x : a) if (x == v) return true;
        return false;
    }

    // ---- 開く・閉じる ----
    @SuppressLint("MissingPermission")
    void open(String id) {
        wantId = id;
        if (thread == null) {
            thread = new HandlerThread("sunglasses-camera");
            thread.start();
            bg = new Handler(thread.getLooper());
        }
        bg.post(() -> {
            try {
                closeDevice();
                cameraId = id;
                chars = mgr.getCameraCharacteristics(id);
                StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                Size[] raws = map.getOutputSizes(ImageFormat.RAW_SENSOR);
                rawSize = largest(raws);
                previewSize = previewSizeFor(map.getOutputSizes(SurfaceTexture.class), rawSize);
                int[] sm = chars.get(CameraCharacteristics.STATISTICS_INFO_AVAILABLE_LENS_SHADING_MAP_MODES);
                shadingMap = has(sm, CameraMetadata.STATISTICS_LENS_SHADING_MAP_MODE_ON);
                int[] tm = chars.get(CameraCharacteristics.TONEMAP_AVAILABLE_TONE_MAP_MODES);
                presetSrgb = has(tm, CameraMetadata.TONEMAP_MODE_PRESET_CURVE);
                renderer.setPreset(presetSrgb);
                int[] af = chars.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
                afContinuous = has(af, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                int[] caps = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
                manualSensor = has(caps, CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR);
                manualPost = has(caps, CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_POST_PROCESSING);
                Range<Integer> er = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
                Rational es = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
                evMin = er == null ? 0 : er.getLower();
                evMax = er == null ? 0 : er.getUpper();
                evStep = es == null ? 1f / 3f : es.floatValue();
                evIndex = 0;
                locked = false;
                if (rawSize != null) {
                    rawReader = ImageReader.newInstance(rawSize.getWidth(), rawSize.getHeight(), ImageFormat.RAW_SENSOR, 3);
                    rawReader.setOnImageAvailableListener(r -> {
                        Image img = r.acquireNextImage();
                        if (img == null) return;
                        synchronized (images) {
                            images.put(img.getTimestamp(), img);
                        }
                        tryWrite(img.getTimestamp());
                    }, bg);
                }
                opening = true;
                mgr.openCamera(id, new CameraDevice.StateCallback() {
                    @Override
                    public void onOpened(CameraDevice d) {
                        opening = false;
                        device = d;
                        startSession();
                    }

                    @Override
                    public void onDisconnected(CameraDevice d) {
                        opening = false;
                        d.close();
                        device = null;
                        emit("closed", "カメラがほかのアプリに使われています");
                    }

                    @Override
                    public void onError(CameraDevice d, int error) {
                        opening = false;
                        d.close();
                        device = null;
                        emit("error", "カメラを開けませんでした（" + error + "）");
                    }
                }, bg);
            } catch (Exception e) {
                opening = false;
                Log.w(TAG, "open", e);
                emit("error", "カメラを開けませんでした（" + e.getMessage() + "）");
            }
        });
    }

    // 撮る画面の描き先ができた（描き直しのたびに作り直される）
    void onSurfaceReady(SurfaceTexture st) {
        if (bg == null) return;
        bg.post(() -> {
            surfaceTexture = st;
            startSession();
        });
    }

    private void startSession() {
        if (device == null || surfaceTexture == null || previewSize == null) return;
        try {
            // 描き先が作り直されたときは、前のつなぎを閉じてからつなぎ直す
            if (session != null) {
                session.close();
                session = null;
            }
            if (previewSurface != null) previewSurface.release();
            surfaceTexture.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
            previewSurface = new Surface(surfaceTexture);
            List<OutputConfiguration> outs = new ArrayList<>();
            outs.add(new OutputConfiguration(previewSurface));
            if (rawReader != null) outs.add(new OutputConfiguration(rawReader.getSurface()));
            Executor ex = bg::post;
            device.createCaptureSession(new SessionConfiguration(SessionConfiguration.SESSION_REGULAR, outs, ex,
                    new CameraCaptureSession.StateCallback() {
                        @Override
                        public void onConfigured(CameraCaptureSession s) {
                            session = s;
                            startPreview();
                            emitOpen();
                        }

                        @Override
                        public void onConfigureFailed(CameraCaptureSession s) {
                            emit("error", "カメラの組み合わせを作れませんでした（RAW の大きさ " + rawSize + "）");
                        }
                    }));
        } catch (Exception e) {
            Log.w(TAG, "session", e);
            emit("error", "カメラの準備ができませんでした（" + e.getMessage() + "）");
        }
    }

    private void startPreview() {
        try {
            preview = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            preview.addTarget(previewSurface);
            preview.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
            preview.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON);
            preview.set(CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_AUTO);
            if (afContinuous) preview.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            if (presetSrgb) {
                // 撮る画面の画を、決まった素直な曲線（sRGB）にする。核をかけたときの見え方が、仕上がりに近くなる
                preview.set(CaptureRequest.TONEMAP_MODE, CameraMetadata.TONEMAP_MODE_PRESET_CURVE);
                preview.set(CaptureRequest.TONEMAP_PRESET_CURVE, CameraMetadata.TONEMAP_PRESET_CURVE_SRGB);
            }
            preview.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, evIndex);
            applyManual(preview);
            repeat();
        } catch (Exception e) {
            Log.w(TAG, "preview", e);
            emit("error", "撮る画面を出せませんでした（" + e.getMessage() + "）");
        }
    }

    private void repeat() throws CameraAccessException {
        if (session == null || preview == null) return;
        session.setRepeatingRequest(preview.build(), new CameraCaptureSession.CaptureCallback() {
            @Override
            public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest r, TotalCaptureResult res) {
                long now = System.currentTimeMillis();
                if (now - lastInfo < 300) return;
                lastInfo = now;
                try {
                    JSONObject o = new JSONObject();
                    o.put("state", "info");
                    Long et = res.get(CaptureResult.SENSOR_EXPOSURE_TIME);
                    Integer iso = res.get(CaptureResult.SENSOR_SENSITIVITY);
                    Integer ae = res.get(CaptureResult.CONTROL_AE_STATE);
                    Integer afs = res.get(CaptureResult.CONTROL_AF_STATE);
                    if (et != null) o.put("exposure", et / 1e9);
                    if (iso != null) o.put("iso", iso);
                    if (ae != null) o.put("ae", ae);
                    if (afs != null) o.put("af", afs);
                    Float fd = res.get(CaptureResult.LENS_FOCUS_DISTANCE);
                    if (fd != null) o.put("focus", fd);
                    RggbChannelVector wg = res.get(CaptureResult.COLOR_CORRECTION_GAINS);
                    if (wg != null) o.put("wbGains", new JSONArray(new float[]{wg.getRed(), wg.getGreenEven(), wg.getGreenOdd(), wg.getBlue()}));
                    o.put("manual", manIso != null && manExp != null);
                    o.put("locked", locked);
                    events.emit("sunglasses:camera", o.toString());
                } catch (Exception ignored) {
                    // 次の画で送る
                }
            }
        }, bg);
    }

    private void emitOpen() {
        try {
            JSONObject o = new JSONObject();
            o.put("state", "open");
            o.put("id", cameraId);
            o.put("raw", rawSize != null);
            o.put("rawSize", rawSize == null ? "" : rawSize.getWidth() + "x" + rawSize.getHeight());
            o.put("preview", previewSize.getWidth() + "x" + previewSize.getHeight());
            o.put("presetCurve", presetSrgb);
            o.put("shadingMap", shadingMap);
            o.put("evMin", evMin * evStep);
            o.put("evMax", evMax * evStep);
            o.put("evStep", evStep);
            Integer so = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
            o.put("sensorOrientation", so == null ? 90 : so);
            events.emit("sunglasses:camera", o.toString());
        } catch (Exception ignored) {
            // 開けたことだけは伝わる
        }
    }

    private void emit(String state, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("state", state);
            o.put("message", message);
            events.emit("sunglasses:camera", o.toString());
        } catch (Exception ignored) {
            // 書けなければ何もしない
        }
    }

    void close() {
        wantId = null;
        if (bg == null) return;
        bg.post(this::closeDevice);
    }

    private void closeDevice() {
        try {
            if (session != null) session.close();
        } catch (Exception ignored) {
            // すでに閉じている
        }
        session = null;
        if (device != null) device.close();
        device = null;
        if (rawReader != null) rawReader.close();
        rawReader = null;
        if (previewSurface != null) previewSurface.release();
        previewSurface = null;
        synchronized (images) {
            for (Image i : images.values()) i.close();
            images.clear();
        }
        results.clear();
    }

    // ---- 明るさの補正・ピント ----
    void setEv(float ev) {
        if (bg == null) return;
        bg.post(() -> {
            evIndex = Math.max(evMin, Math.min(evMax, Math.round(ev / evStep)));
            if (preview == null) return;
            preview.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, evIndex);
            try {
                repeat();
            } catch (Exception e) {
                Log.w(TAG, "ev", e);
            }
        });
    }

    // nx・ny は撮る画面の枠の中の位置（0〜1、左上が原点）。lock なら明るさとピントを固定する
    void focusAt(float nx, float ny, boolean lock) {
        if (bg == null) return;
        bg.post(() -> {
            if (preview == null || session == null || chars == null) return;
            try {
                Rect a = chars.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
                Integer so = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
                float sx, sy;
                switch (so == null ? 90 : so) {
                    case 270: sx = 1 - ny; sy = nx; break;
                    case 180: sx = 1 - nx; sy = 1 - ny; break;
                    case 0: sx = nx; sy = ny; break;
                    default: sx = ny; sy = 1 - nx;
                }
                int cx = a.left + Math.round(sx * a.width()), cy = a.top + Math.round(sy * a.height());
                int half = Math.round(Math.min(a.width(), a.height()) * 0.06f);
                MeteringRectangle m = new MeteringRectangle(Math.max(a.left, cx - half), Math.max(a.top, cy - half),
                        half * 2, half * 2, MeteringRectangle.METERING_WEIGHT_MAX - 1);
                Integer maxAf = chars.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF);
                Integer maxAe = chars.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE);
                if (maxAe != null && maxAe > 0) preview.set(CaptureRequest.CONTROL_AE_REGIONS, new MeteringRectangle[]{m});
                locked = lock;
                preview.set(CaptureRequest.CONTROL_AE_LOCK, false);
                if (maxAf != null && maxAf > 0) {
                    preview.set(CaptureRequest.CONTROL_AF_REGIONS, new MeteringRectangle[]{m});
                    preview.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO);
                    preview.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_START);
                    session.capture(preview.build(), null, bg);
                    preview.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_IDLE);
                }
                if (lock) {
                    // 明るさを合わせ終わってから固定する
                    bg.postDelayed(() -> {
                        if (preview == null) return;
                        preview.set(CaptureRequest.CONTROL_AE_LOCK, true);
                        try {
                            repeat();
                        } catch (Exception ignored) {
                            // 次の操作で直る
                        }
                    }, 600);
                }
                repeat();
            } catch (Exception e) {
                Log.w(TAG, "focus", e);
            }
        });
    }

    void unlock() {
        if (bg == null) return;
        bg.post(() -> {
            if (preview == null) return;
            locked = false;
            preview.set(CaptureRequest.CONTROL_AE_LOCK, false);
            preview.set(CaptureRequest.CONTROL_AE_REGIONS, null);
            preview.set(CaptureRequest.CONTROL_AF_REGIONS, null);
            if (afContinuous) preview.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            try {
                repeat();
            } catch (Exception e) {
                Log.w(TAG, "unlock", e);
            }
        });
    }

    // ---- 手動のシャッター速度・ISO・WB・フォーカス・AF（版 3）----
    // json の例: {"iso":200,"exposure":0.004,"focus":2.5,"af":"single","wb":"daylight","wbGains":[2.0,1,1,1.6]}
    // iso と exposure は 2 つそろったときだけ手動にする（片方だけ手で決めるときは、ページがもう片方を計算して渡す）
    void setManual(String json) {
        if (bg == null) return;
        bg.post(() -> {
            try {
                JSONObject o = new JSONObject(json);
                manIso = o.isNull("iso") ? null : o.optInt("iso");
                manExp = o.isNull("exposure") ? null : Math.round(o.optDouble("exposure") * 1e9);
                manFocus = o.isNull("focus") ? null : (float) o.optDouble("focus");
                afMode = o.optString("af", "continuous");
                wbMode = o.optString("wb", "auto");
                JSONArray g = o.optJSONArray("wbGains");
                wbGains = g == null || g.length() < 4 ? null
                        : new float[]{(float) g.getDouble(0), (float) g.getDouble(1), (float) g.getDouble(2), (float) g.getDouble(3)};
                if (preview == null) return;
                applyManual(preview);
                repeat();
            } catch (Exception e) {
                Log.w(TAG, "manual", e);
            }
        });
    }

    private void applyManual(CaptureRequest.Builder b) {
        if (manualSensor && manIso != null && manExp != null) {
            b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF);
            b.set(CaptureRequest.SENSOR_SENSITIVITY, manIso);
            b.set(CaptureRequest.SENSOR_EXPOSURE_TIME, manExp);
            b.set(CaptureRequest.SENSOR_FRAME_DURATION, Math.max(manExp, 33_333_333L));
        } else {
            b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON);
            b.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, evIndex);
        }
        if (manFocus != null && manualSensor) {
            b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF);
            b.set(CaptureRequest.LENS_FOCUS_DISTANCE, manFocus);
        } else if ("single".equals(afMode)) {
            b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO);
        } else if (afContinuous) {
            b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
        }
        if (wbGains != null && manualPost) {
            b.set(CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_OFF);
            b.set(CaptureRequest.COLOR_CORRECTION_MODE, CameraMetadata.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX);
            b.set(CaptureRequest.COLOR_CORRECTION_GAINS, new RggbChannelVector(wbGains[0], wbGains[1], wbGains[2], wbGains[3]));
        } else {
            int m;
            switch (wbMode) {
                case "daylight": m = CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT; break;
                case "cloudy": m = CameraMetadata.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT; break;
                case "shade": m = CameraMetadata.CONTROL_AWB_MODE_SHADE; break;
                case "incandescent": m = CameraMetadata.CONTROL_AWB_MODE_INCANDESCENT; break;
                case "fluorescent": m = CameraMetadata.CONTROL_AWB_MODE_FLUORESCENT; break;
                case "twilight": m = CameraMetadata.CONTROL_AWB_MODE_TWILIGHT; break;
                default: m = CameraMetadata.CONTROL_AWB_MODE_AUTO;
            }
            b.set(CaptureRequest.CONTROL_AWB_MODE, m);
        }
    }

    // ---- 撮る ----
    void capture(boolean withSound) {
        sound = withSound;
        if (bg == null) return;
        bg.post(() -> {
            if (session == null || device == null) {
                emitCaptured(false, "カメラが開いていません", null);
                return;
            }
            if (rawReader == null) {
                emitCaptured(false, "この端末のこのカメラは、ほかのアプリに RAW を渡しません", null);
                return;
            }
            try {
                CaptureRequest.Builder b = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                b.addTarget(rawReader.getSurface());
                b.addTarget(previewSurface);
                b.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
                b.set(CaptureRequest.CONTROL_AE_LOCK, locked);
                if (preview.get(CaptureRequest.CONTROL_AE_REGIONS) != null) b.set(CaptureRequest.CONTROL_AE_REGIONS, preview.get(CaptureRequest.CONTROL_AE_REGIONS));
                Integer afMode = preview.get(CaptureRequest.CONTROL_AF_MODE);
                if (afMode != null) b.set(CaptureRequest.CONTROL_AF_MODE, afMode);
                if (presetSrgb) {
                    b.set(CaptureRequest.TONEMAP_MODE, CameraMetadata.TONEMAP_MODE_PRESET_CURVE);
                    b.set(CaptureRequest.TONEMAP_PRESET_CURVE, CameraMetadata.TONEMAP_PRESET_CURVE_SRGB);
                }
                if (shadingMap) b.set(CaptureRequest.STATISTICS_LENS_SHADING_MAP_MODE, CameraMetadata.STATISTICS_LENS_SHADING_MAP_MODE_ON);
                applyManual(b);
                if (manFocus == null && afMode.equals("continuous") && afMode != null && afContinuous) b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                session.capture(b.build(), new CameraCaptureSession.CaptureCallback() {
                    @Override
                    public void onCaptureStarted(CameraCaptureSession s, CaptureRequest r, long ts, long frame) {
                        if (sound) shutter.play(MediaActionSound.SHUTTER_CLICK);
                    }

                    @Override
                    public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest r, TotalCaptureResult res) {
                        Long ts = res.get(CaptureResult.SENSOR_TIMESTAMP);
                        if (ts == null) return;
                        synchronized (images) {
                            results.put(ts, res);
                        }
                        tryWrite(ts);
                    }

                    @Override
                    public void onCaptureFailed(CameraCaptureSession s, CaptureRequest r, android.hardware.camera2.CaptureFailure f) {
                        emitCaptured(false, "撮れませんでした（" + f.getReason() + "）", null);
                    }
                }, bg);
            } catch (Exception e) {
                Log.w(TAG, "capture", e);
                emitCaptured(false, "撮れませんでした（" + e.getMessage() + "）", null);
            }
        });
    }

    // RAW の画と撮影の結果がそろったら、DNG にして保存する
    private void tryWrite(long ts) {
        Image img;
        TotalCaptureResult res;
        synchronized (images) {
            img = images.get(ts);
            res = results.get(ts);
            if (img == null || res == null) return;
            images.remove(ts);
            results.remove(ts);
        }
        ContentResolver cr = ctx.getContentResolver();
        String name = "SG_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date()) + ".dng";
        long taken = System.currentTimeMillis();
        Uri uri = null;
        try (DngCreator dng = new DngCreator(chars, res)) {
            dng.setOrientation(exifOrientation());
            dng.setDescription("Sunglasses");
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, "image/x-adobe-dng");
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DCIM + "/Sunglasses");
            v.put(MediaStore.MediaColumns.DATE_TAKEN, taken);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            uri = cr.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
            if (uri == null) throw new IllegalStateException("保存先を作れませんでした");
            try (OutputStream os = cr.openOutputStream(uri)) {
                dng.writeImage(os, img);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, done, null, null);
            long modified = taken / 1000, size = -1;
            try (Cursor c = cr.query(uri, new String[]{MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.SIZE}, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    modified = c.getLong(0);
                    size = c.getLong(1);
                }
            } catch (Exception ignored) {
                // 読めなければ撮った時刻
            }
            JSONObject item = new JSONObject();
            item.put("id", Long.parseLong(uri.getLastPathSegment()));
            item.put("volume", MediaStore.VOLUME_EXTERNAL_PRIMARY);
            item.put("name", name);
            item.put("dateTaken", taken);
            item.put("dateModified", modified);
            item.put("size", size);
            item.put("width", img.getWidth());
            item.put("height", img.getHeight());
            item.put("folder", "DCIM/Sunglasses/");
            item.put("mime", "image/x-adobe-dng");
            item.put("uri", uri.toString());
            emitCaptured(true, null, item);
        } catch (Exception e) {
            Log.w(TAG, "write", e);
            if (uri != null) {
                try {
                    cr.delete(uri, null, null);
                } catch (Exception ignored) {
                    // 消せなくても続ける
                }
            }
            emitCaptured(false, "保存できませんでした（" + e.getMessage() + "）", null);
        } finally {
            img.close();
        }
    }

    private void emitCaptured(boolean ok, String error, JSONObject item) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", ok);
            if (error != null) o.put("error", error);
            if (item != null) o.put("item", item);
            events.emit("sunglasses:captured", o.toString());
        } catch (Exception ignored) {
            // 書けなければ何もしない
        }
    }

    // 端末の向き（0・90・180・270）とセンサーの向きから、写真の向き（EXIF の値）を決める
    private int exifOrientation() {
        Integer so = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
        int deg = ((so == null ? 90 : so) + deviceRotation) % 360;
        switch (deg) {
            case 90: return ExifInterface.ORIENTATION_ROTATE_90;
            case 180: return ExifInterface.ORIENTATION_ROTATE_180;
            case 270: return ExifInterface.ORIENTATION_ROTATE_270;
            default: return ExifInterface.ORIENTATION_NORMAL;
        }
    }

    private static Size largest(Size[] s) {
        if (s == null || s.length == 0) return null;
        List<Size> l = new ArrayList<>(Arrays.asList(s));
        Collections.sort(l, (a, b) -> Long.compare((long) b.getWidth() * b.getHeight(), (long) a.getWidth() * a.getHeight()));
        return l.get(0);
    }

    // 撮る画面の画の大きさ: RAW と同じ縦横の比で、横 1920 までのいちばん大きいもの
    private static Size previewSizeFor(Size[] s, Size raw) {
        double want = raw == null ? 4.0 / 3.0 : (double) raw.getWidth() / raw.getHeight();
        Size best = null;
        for (Size x : s) {
            if (x.getWidth() > 1920) continue;
            if (Math.abs((double) x.getWidth() / x.getHeight() - want) > 0.02) continue;
            if (best == null || x.getWidth() > best.getWidth()) best = x;
        }
        if (best == null) {
            for (Size x : s) if (x.getWidth() <= 1920 && (best == null || x.getWidth() > best.getWidth())) best = x;
        }
        return best != null ? best : s[0];
    }

    void release() {
        close();
        shutter.release();
        if (thread != null) thread.quitSafely();
        thread = null;
        bg = null;
    }
}
