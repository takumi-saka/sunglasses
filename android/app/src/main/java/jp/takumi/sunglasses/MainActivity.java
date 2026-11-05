package jp.takumi.sunglasses;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.util.Size;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * サングラスのアプリ。GitHub のページ（https://takumi-saka.github.io/sunglasses/）を画面いっぱいに開く。
 * 画の処理と画面はページが受け持つので、ページを新しくすればアプリも新しくなる（入れ直しは要らない）。
 *
 * このファイルは、ページだけではできないスマホの機能の窓口（window.SunglassesBridge）を受け持つ。
 *   RAW の一覧と読み込み、一覧の小さな画、ほかのアプリからの共有、書き出しの保存
 *   （撮影日時と撮影の情報を元の写真から写す）、共有、振動、画面の点灯、戻る操作。
 * 窓口を変えたら BRIDGE_VERSION を上げる。ページはこの数字を見て、入れ直しが要るかを知らせる。
 *
 * ページから読むファイルは、https://takumi-saka.github.io/sunglasses/__local/... の住所で渡す
 * （同じ住所の中なので、ページから普通に fetch で読める）。
 *   __local/media/{volume}/{id}   写真の元のファイル
 *   __local/thumb/{volume}/{id}?s=384   写真の小さな画（JPEG）
 *   __local/opened/{token}   ほかのアプリから渡された・選んだファイル
 */
public class MainActivity extends Activity {
    private static final String TAG = "Sunglasses";
    private static final String HOST = "takumi-saka.github.io";
    private static final String START_URL = "https://" + HOST + "/sunglasses/";
    private static final String LOCAL = "/sunglasses/__local/";
    private static final int BRIDGE_VERSION = 1;
    private static final int REQ_PICK = 1;
    private static final int REQ_CHOOSER = 2;
    private static final int REQ_PERMISSION = 3;
    private static final String[] RAW_MIMES = {"image/x-adobe-dng", "image/dng"};

    // 書き出しに写す撮影の情報（場所は別。ページが「場所も写す」と言ったときだけ写す）
    private static final String[] COPY_TAGS = {
            "DateTimeOriginal", "DateTimeDigitized", "SubSecTimeOriginal", "SubSecTimeDigitized",
            "OffsetTime", "OffsetTimeOriginal", "OffsetTimeDigitized",
            "Make", "Model", "LensMake", "LensModel",
            "ISOSpeedRatings", "PhotographicSensitivity", "ExposureTime", "FNumber", "ApertureValue",
            "ShutterSpeedValue", "FocalLength", "FocalLengthIn35mmFilm", "ExposureBiasValue",
            "ExposureProgram", "MeteringMode", "Flash", "WhiteBalance"};
    private static final String[] GPS_TAGS = {
            "GPSLatitude", "GPSLatitudeRef", "GPSLongitude", "GPSLongitudeRef", "GPSAltitude", "GPSAltitudeRef",
            "GPSTimeStamp", "GPSDateStamp", "GPSImgDirection", "GPSImgDirectionRef"};

    private WebView web;
    private ValueCallback<Uri[]> chooserCallback;
    private final Map<String, Uri> opened = new ConcurrentHashMap<>();
    private final List<String> openedQueue = Collections.synchronizedList(new ArrayList<>());
    private final Map<String, File> saving = new ConcurrentHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        WebView.setWebContentsDebuggingEnabled(true);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setHapticFeedbackEnabled(true);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + " SunglassesApp/" + BRIDGE_VERSION);

        web.addJavascriptInterface(new Bridge(), "SunglassesBridge");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        // ページの裏で動く部品（サービスワーカー）が読むときも、同じ住所でスマホのファイルを渡す
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return intercept(request.getUrl());
            }
        });

        handleIntent(getIntent());
        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(START_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 純正カメラで撮って戻ってきたときに、ページが一覧を読み直せるように知らせる
        dispatch("sunglasses:resume", "");
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.__sunglassesBack && window.__sunglassesBack()) ? 'handled' : 'no'", v -> {
            if (v != null && v.contains("handled")) return;
            if (web.canGoBack()) {
                web.goBack();
            } else {
                finish();
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        List<Uri> uris = new ArrayList<>();
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        }
        if (requestCode == REQ_CHOOSER) {
            if (chooserCallback != null) chooserCallback.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
            chooserCallback = null;
            return;
        }
        if (requestCode == REQ_PICK && !uris.isEmpty()) {
            for (Uri u : uris) queueOpened(u);
            dispatch("sunglasses:opened", "");
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERMISSION) dispatch("sunglasses:permission", permissionState());
    }

    // ---- ほかのアプリから渡されたファイル ----

    private void handleIntent(Intent i) {
        if (i == null || i.getAction() == null) return;
        Uri u = null;
        if (Intent.ACTION_SEND.equals(i.getAction())) {
            u = i.getParcelableExtra(Intent.EXTRA_STREAM);
        } else if (Intent.ACTION_VIEW.equals(i.getAction()) || Intent.ACTION_EDIT.equals(i.getAction())) {
            u = i.getData();
        }
        if (u == null) return;
        queueOpened(u);
        dispatch("sunglasses:opened", "");
    }

    private void queueOpened(Uri u) {
        String token = UUID.randomUUID().toString();
        opened.put(token, u);
        openedQueue.add(token);
    }

    // ---- ページへの知らせ ----

    private void dispatch(String name, String detail) {
        if (web == null) return;
        final String js = "window.dispatchEvent(new CustomEvent(" + JSONObject.quote(name) + ",{detail:" + JSONObject.quote(detail) + "}))";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    private void showOffline() {
        String html = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<body style='background:#000;color:#ddd;font-family:sans-serif;padding:32px;line-height:1.8'>"
                + "<p>ページを読み込めませんでした。</p>"
                + "<p>はじめて開くときは、ネットにつないでください。一度開けば、あとは電波がなくても使えます。</p>"
                + "<p><button onclick='SunglassesBridge.reload()' style='font-size:16px;padding:10px 18px'>もう一度読み込む</button></p>"
                + "</body>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    // ---- スマホのファイルを、ページから読める住所で渡す ----

    private WebResourceResponse intercept(Uri url) {
        if (url == null || !HOST.equals(url.getHost())) return null;
        String path = url.getPath();
        if (path == null || !path.startsWith(LOCAL)) return null;
        List<String> seg = url.getPathSegments();  // sunglasses, __local, 種類, ...
        try {
            String kind = seg.size() > 2 ? seg.get(2) : "";
            switch (kind) {
                case "media":
                    return stream(original(mediaUri(seg.get(3), Long.parseLong(seg.get(4)))), "application/octet-stream");
                case "thumb":
                    return thumb(mediaUri(seg.get(3), Long.parseLong(seg.get(4))), intOr(url.getQueryParameter("s"), 384));
                case "opened": {
                    Uri u = opened.get(seg.get(3));
                    return u == null ? text(404, "not found") : stream(u, "application/octet-stream");
                }
                case "ping":
                    return text(200, "ok");
                default:
                    return text(404, "not found");
            }
        } catch (Exception e) {
            Log.w(TAG, "local " + path, e);
            return text(500, String.valueOf(e));
        }
    }

    private static Map<String, String> headers() {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        h.put("Access-Control-Allow-Origin", "*");
        return h;
    }

    private WebResourceResponse stream(Uri u, String mime) throws Exception {
        InputStream in = getContentResolver().openInputStream(u);
        if (in == null) return text(404, "not found");
        Map<String, String> h = headers();
        long size = sizeOf(u);
        if (size > 0) h.put("Content-Length", String.valueOf(size));
        return new WebResourceResponse(mime, null, 200, "OK", h, in);
    }

    private WebResourceResponse thumb(Uri u, int s) throws Exception {
        Bitmap b = getContentResolver().loadThumbnail(u, new Size(s, s), null);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.JPEG, 88, bo);
        b.recycle();
        return new WebResourceResponse("image/jpeg", null, 200, "OK", headers(), new ByteArrayInputStream(bo.toByteArray()));
    }

    private static WebResourceResponse text(int code, String body) {
        return new WebResourceResponse("text/plain", "utf-8", code, code == 200 ? "OK" : "Error", headers(),
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    private static Uri mediaUri(String volume, long id) {
        return ContentUris.withAppendedId(MediaStore.Images.Media.getContentUri(volume), id);
    }

    // 位置の情報を消さずに読む（許可があるとき。無ければそのまま）
    private Uri original(Uri u) {
        if (checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            try {
                return MediaStore.setRequireOriginal(u);
            } catch (Exception ignored) {
                return u;
            }
        }
        return u;
    }

    private long sizeOf(Uri u) {
        try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) {
            // 大きさが分からなくても読める
        }
        return -1;
    }

    private String nameOf(Uri u) {
        try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {
            // 名前が分からなければ住所の最後
        }
        return u.getLastPathSegment();
    }

    private static int intOr(String s, int d) {
        try {
            return s == null ? d : Integer.parseInt(s);
        } catch (Exception e) {
            return d;
        }
    }

    // ---- 写真の許可 ----

    private String permissionState() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED) return "full";
            if (Build.VERSION.SDK_INT >= 34
                    && checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED) return "partial";
            return "none";
        }
        return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED ? "full" : "none";
    }

    private String[] permissionsToAsk() {
        if (Build.VERSION.SDK_INT >= 34) {
            return new String[]{Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
                    Manifest.permission.ACCESS_MEDIA_LOCATION};
        }
        if (Build.VERSION.SDK_INT >= 33) {
            return new String[]{Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.ACCESS_MEDIA_LOCATION};
        }
        return new String[]{Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.ACCESS_MEDIA_LOCATION};
    }

    // ---- RAW の一覧（新しい順） ----

    private String listRawJson() {
        List<JSONObject> rows = new ArrayList<>();
        if (!"none".equals(permissionState())) {
            Uri coll = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
            String[] proj = {
                    MediaStore.MediaColumns._ID, MediaStore.MediaColumns.VOLUME_NAME, MediaStore.MediaColumns.DISPLAY_NAME,
                    MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.SIZE,
                    MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT, MediaStore.MediaColumns.ORIENTATION,
                    MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.MIME_TYPE};
            String sel = MediaStore.MediaColumns.MIME_TYPE + " IN (?, ?) OR " + MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?";
            String[] args = {RAW_MIMES[0], RAW_MIMES[1], "%.dng"};
            try (Cursor c = getContentResolver().query(coll, proj, sel, args, null)) {
                while (c != null && c.moveToNext()) {
                    try {
                        long taken = c.isNull(3) ? 0 : c.getLong(3);
                        long modified = c.isNull(4) ? 0 : c.getLong(4) * 1000L;
                        JSONObject o = new JSONObject();
                        o.put("id", c.getLong(0));
                        o.put("volume", c.getString(1));
                        o.put("name", c.getString(2));
                        o.put("dateTaken", taken > 0 ? taken : modified);
                        o.put("dateModified", modified);
                        o.put("size", c.getLong(5));
                        o.put("width", c.getInt(6));
                        o.put("height", c.getInt(7));
                        o.put("orientation", c.getInt(8));
                        o.put("folder", c.getString(9));
                        o.put("mime", c.getString(10));
                        rows.add(o);
                    } catch (Exception ignored) {
                        // 読めない行は飛ばす
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "list", e);
            }
        }
        Collections.sort(rows, (a, b) -> Long.compare(b.optLong("dateTaken"), a.optLong("dateTaken")));
        JSONArray out = new JSONArray();
        for (JSONObject o : rows) out.put(o);
        return out.toString();
    }

    // ---- 書き出しの保存 ----

    private String saveFinishImpl(String token, String name, String relativePath, String sourceJson, String note) {
        File f = saving.remove(token);
        JSONObject res = new JSONObject();
        try {
            if (f == null || !f.exists()) throw new IllegalStateException("書き出しのデータがありません");
            JSONObject src = sourceJson == null || sourceJson.isEmpty() ? new JSONObject() : new JSONObject(sourceJson);
            Uri srcUri = null;
            if ("media".equals(src.optString("kind"))) {
                srcUri = original(mediaUri(src.optString("volume", MediaStore.VOLUME_EXTERNAL_PRIMARY), src.optLong("id")));
            } else if ("opened".equals(src.optString("kind"))) {
                srcUri = opened.get(src.optString("token"));
            }
            long taken = src.optLong("dateTaken", 0);
            if (srcUri != null) taken = copyExif(srcUri, f, note, src.optBoolean("copyLocation", false), taken);

            ContentResolver cr = getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg");
            v.put(MediaStore.MediaColumns.RELATIVE_PATH,
                    relativePath == null || relativePath.isEmpty() ? Environment.DIRECTORY_PICTURES + "/Sunglasses" : relativePath);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            if (taken > 0) v.put(MediaStore.MediaColumns.DATE_TAKEN, taken);
            Uri out = cr.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
            if (out == null) throw new IllegalStateException("保存先を作れませんでした");
            try (OutputStream os = cr.openOutputStream(out); InputStream in = new FileInputStream(f)) {
                if (os == null) throw new IllegalStateException("保存先に書けませんでした");
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(out, done, null, null);
            res.put("ok", true);
            res.put("uri", out.toString());
        } catch (Exception e) {
            Log.w(TAG, "save", e);
            try {
                res.put("ok", false);
                res.put("error", String.valueOf(e.getMessage() != null ? e.getMessage() : e));
            } catch (Exception ignored) {
                // 書けなければ空の答え
            }
        } finally {
            if (f != null) //noinspection ResultOfMethodCallIgnored
                f.delete();
        }
        return res.toString();
    }

    // 元の写真の撮影の情報を、書き出した JPEG に写す。戻り値は撮影日時（1970 年からのミリ秒）
    private long copyExif(Uri src, File dst, String note, boolean copyLocation, long taken) {
        try (ParcelFileDescriptor pfd = getContentResolver().openFileDescriptor(src, "r")) {
            if (pfd == null) return taken;
            ExifInterface in = new ExifInterface(pfd.getFileDescriptor());
            ExifInterface out = new ExifInterface(dst.getAbsolutePath());
            for (String t : COPY_TAGS) {
                String v = in.getAttribute(t);
                if (v != null) out.setAttribute(t, v);
            }
            if (copyLocation) {
                for (String t : GPS_TAGS) {
                    String v = in.getAttribute(t);
                    if (v != null) out.setAttribute(t, v);
                }
            }
            String dto = in.getAttribute("DateTimeOriginal");
            if (dto != null) out.setAttribute("DateTime", dto);
            out.setAttribute("Orientation", "1");
            out.setAttribute("Software", "Sunglasses");
            if (note != null && !note.isEmpty()) out.setAttribute("ImageDescription", note);
            out.saveAttributes();
            if (taken <= 0 && dto != null) taken = exifTime(dto, in.getAttribute("OffsetTimeOriginal"));
        } catch (Exception e) {
            Log.w(TAG, "exif", e);
        }
        return taken;
    }

    private static long exifTime(String dateTime, String offset) {
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US);
            if (offset != null && offset.matches("[+-]\\d\\d:\\d\\d")) {
                f.setTimeZone(TimeZone.getTimeZone("GMT" + offset));
            } else {
                f.setTimeZone(TimeZone.getDefault());
            }
            Date d = f.parse(dateTime);
            return d == null ? 0 : d.getTime();
        } catch (Exception e) {
            return 0;
        }
    }

    private void openExternal(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception ignored) {
            // 開けるアプリがなければ何もしない
        }
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (HOST.equals(u.getHost())) return false;
            openExternal(u);
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return intercept(request.getUrl());
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showOffline();
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (chooserCallback != null) chooserCallback.onReceiveValue(null);
            chooserCallback = callback;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try {
                startActivityForResult(i, REQ_CHOOSER);
            } catch (Exception e) {
                chooserCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            Log.d(TAG, m.sourceId() + ":" + m.lineNumber() + " " + m.message());
            return true;
        }
    }

    /** ページから呼ぶための窓口（window.SunglassesBridge） */
    private class Bridge {
        @JavascriptInterface
        public int version() {
            return BRIDGE_VERSION;
        }

        @JavascriptInterface
        public String appInfo() {
            JSONObject o = new JSONObject();
            try {
                PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
                o.put("bridge", BRIDGE_VERSION);
                o.put("versionCode", p.getLongVersionCode());
                o.put("versionName", p.versionName);
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("manufacturer", Build.MANUFACTURER);
                o.put("model", Build.MODEL);
            } catch (Exception ignored) {
                // 分かる所だけ返す
            }
            return o.toString();
        }

        @JavascriptInterface
        public String mediaPermission() {
            return permissionState();
        }

        @JavascriptInterface
        public void requestMediaPermission() {
            runOnUiThread(() -> requestPermissions(permissionsToAsk(), REQ_PERMISSION));
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
                } catch (Exception ignored) {
                    // 設定の画面が無ければ何もしない
                }
            });
        }

        @JavascriptInterface
        public String listRaw() {
            return listRawJson();
        }

        @JavascriptInterface
        public void pickFiles() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{RAW_MIMES[0], RAW_MIMES[1], "image/jpeg", "application/octet-stream"});
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(i, REQ_PICK);
                } catch (Exception e) {
                    Log.w(TAG, "pick", e);
                }
            });
        }

        @JavascriptInterface
        public String takeOpened() {
            JSONArray out = new JSONArray();
            List<String> tokens;
            synchronized (openedQueue) {
                tokens = new ArrayList<>(openedQueue);
                openedQueue.clear();
            }
            for (String t : tokens) {
                Uri u = opened.get(t);
                if (u == null) continue;
                try {
                    JSONObject o = new JSONObject();
                    o.put("token", t);
                    o.put("name", nameOf(u));
                    o.put("mime", getContentResolver().getType(u));
                    o.put("size", sizeOf(u));
                    out.put(o);
                } catch (Exception ignored) {
                    // 読めないものは飛ばす
                }
            }
            return out.toString();
        }

        @JavascriptInterface
        public String saveBegin() {
            String token = UUID.randomUUID().toString();
            File f = new File(getCacheDir(), "save-" + token + ".jpg");
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            saving.put(token, f);
            return token;
        }

        @JavascriptInterface
        public boolean saveAppend(String token, String base64) {
            File f = saving.get(token);
            if (f == null) return false;
            try (FileOutputStream os = new FileOutputStream(f, true)) {
                os.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                Log.w(TAG, "append", e);
                return false;
            }
        }

        @JavascriptInterface
        public String saveFinish(String token, String name, String relativePath, String sourceJson, String note) {
            return saveFinishImpl(token, name, relativePath, sourceJson, note);
        }

        @JavascriptInterface
        public void saveCancel(String token) {
            File f = saving.remove(token);
            if (f != null) //noinspection ResultOfMethodCallIgnored
                f.delete();
        }

        @JavascriptInterface
        public void share(String uri) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("image/jpeg");
                i.putExtra(Intent.EXTRA_STREAM, Uri.parse(uri));
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivity(Intent.createChooser(i, null));
                } catch (Exception ignored) {
                    // 送れるアプリがなければ何もしない
                }
            });
        }

        @JavascriptInterface
        public void view(String uri) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(Uri.parse(uri), "image/jpeg");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivity(i);
                } catch (Exception ignored) {
                    // 開けるアプリがなければ何もしない
                }
            });
        }

        @JavascriptInterface
        public void haptic(String kind) {
            runOnUiThread(() -> {
                int c;
                switch (kind == null ? "" : kind) {
                    case "detent":
                        c = Build.VERSION.SDK_INT >= 34 ? HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE : HapticFeedbackConstants.CONTEXT_CLICK;
                        break;
                    case "tick":
                        c = Build.VERSION.SDK_INT >= 34 ? HapticFeedbackConstants.SEGMENT_FREQUENT_TICK : HapticFeedbackConstants.CLOCK_TICK;
                        break;
                    case "confirm":
                        c = Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.LONG_PRESS;
                        break;
                    case "reject":
                        c = Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
                        break;
                    default:
                        c = HapticFeedbackConstants.KEYBOARD_TAP;
                }
                web.performHapticFeedback(c);
            });
        }

        @JavascriptInterface
        public void keepScreenOn(final boolean on) {
            runOnUiThread(() -> {
                if (on) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void openUrl(String url) {
            runOnUiThread(() -> openExternal(Uri.parse(url)));
        }

        @JavascriptInterface
        public void reload() {
            runOnUiThread(() -> web.loadUrl(START_URL));
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(MainActivity.this::finish);
        }
    }
}
