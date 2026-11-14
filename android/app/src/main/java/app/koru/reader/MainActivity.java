package app.koru.reader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.core.content.FileProvider;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import app.koru.reader.backend.KoruBackend;

/**
 * Koru on Android: the same page as the desktop app (web/, packed as the APK's assets), shown in a WebView.
 * The page lives at https://appassets.androidplatform.net/ (a name reserved for exactly this, it never goes
 * out to the internet). Its /k/... requests are answered by KoruBackend, the Android port of the desktop
 * app's background side.
 */
public class MainActivity extends Activity implements KoruBackend.Opener {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;

    private WebView web;
    private FrameLayout frame;
    private KoruBackend backend;
    private boolean immersive = false;
    // WebView doesn't hand request bodies to shouldInterceptRequest, so the page parks them here first
    // (core.js does this for every POST/PUT to /k/) and sends the id in an X-Koru-Body header.
    private final Map<String, byte[]> bodies = new ConcurrentHashMap<>();

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String version = "0.0.0";
        try { version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) {}
        backend = new KoruBackend(this, version);
        backend.setOpener(this);

        if (BuildConfig.DEBUG || BuildConfig.INSPECT) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#07081a"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "KoruNative");
        web.setWebViewClient(new Client());
        web.setDownloadListener((url, ua, disposition, mime, length) -> saveUrl(url, disposition, mime));

        // Edge to edge: the page fills the screen, and the system bars' space is kept free with padding
        // (dropped in full-screen reading).
        frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.parseColor("#07081a"));
        frame.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        frame.setOnApplyWindowInsetsListener((v, insets) -> {
            if (immersive) v.setPadding(0, 0, 0, 0);
            else {
                android.graphics.Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(b.left, b.top, b.right, b.bottom);
            }
            return WindowInsets.CONSUMED;
        });
        getWindow().setDecorFitsSystemWindows(false);
        setContentView(frame);

        if (state != null) web.restoreState(state);
        else web.loadUrl(ORIGIN + "/index.html");
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override protected void onPause() { super.onPause(); web.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
    @Override protected void onDestroy() { web.destroy(); super.onDestroy(); }

    // Back: the page decides first (close the reader, a sheet, or go back a page); at the Library it leaves.
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(function(){try{return window.KoruBack?!!window.KoruBack():false}catch(e){return false}})()", v -> {
            if (!"true".equals(v)) moveTaskToBack(true);
        });
    }

    private void setFullscreen(boolean on) {
        immersive = on;
        WindowInsetsController c = getWindow().getInsetsController();
        if (c != null) {
            if (on) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else c.show(WindowInsets.Type.systemBars());
        }
        frame.requestApplyInsets();
    }

    // ---------- the page's requests ----------
    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost())) return null;   // pictures straight from a site (rare) load normally
            String path = u.getPath() == null ? "/" : u.getPath();
            if (path.startsWith("/k/")) {
                Map<String, String> h = req.getRequestHeaders();
                byte[] body = null;
                String id = h == null ? null : h.get("X-Koru-Body");
                if (id == null && h != null) id = h.get("x-koru-body");
                if (id != null) body = bodies.remove(id);
                return backend.handle(req.getMethod(), u, h == null ? new HashMap<>() : h, body);
            }
            return asset(path);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (HOST.equals(u.getHost())) return false;
            openExternal(u.toString());   // a normal link to a website opens in the browser
            return true;
        }
    }

    private WebResourceResponse asset(String path) {
        if (path.equals("/") || path.isEmpty()) path = "/index.html";
        String rel = path.substring(1);
        if (rel.contains("..")) return text(403, "Forbidden");
        try {
            InputStream in = getAssets().open(rel);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            return new WebResourceResponse(mime(rel), "utf-8", 200, "OK", h, in);
        } catch (Exception e) { return text(404, "Not found"); }
    }

    private static String mime(String p) {
        String l = p.toLowerCase();
        if (l.endsWith(".html")) return "text/html";
        if (l.endsWith(".js")) return "text/javascript";
        if (l.endsWith(".css")) return "text/css";
        if (l.endsWith(".svg")) return "image/svg+xml";
        if (l.endsWith(".png")) return "image/png";
        if (l.endsWith(".jpg") || l.endsWith(".jpeg")) return "image/jpeg";
        if (l.endsWith(".webp")) return "image/webp";
        if (l.endsWith(".ico")) return "image/x-icon";
        if (l.endsWith(".json")) return "application/json";
        if (l.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private static WebResourceResponse text(int status, String msg) {
        return new WebResourceResponse("text/plain", "utf-8", status, msg, new HashMap<>(), new ByteArrayInputStream(msg.getBytes()));
    }

    // ---------- things the page asks of Android ----------
    private class Bridge {
        @JavascriptInterface public String stash(String body) {
            String id = UUID.randomUUID().toString();
            bodies.put(id, body == null ? new byte[0] : body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return id;
        }
        @JavascriptInterface public void immersive(boolean on) { runOnUiThread(() -> setFullscreen(on)); }
        @JavascriptInterface public void saveFile(String name, String mime, String base64) {
            new Thread(() -> {
                try { toastSaved(writeDownload(name, mime, new ByteArrayInputStream(Base64.decode(base64, Base64.DEFAULT)))); }
                catch (Exception e) { toast("Couldn't save the file: " + e.getMessage(), "error"); }
            }).start();
        }
        // one of Koru's own files (a .cbz export): the app reads it and writes it to Downloads/Koru
        @JavascriptInterface public void saveKoru(String path, String name) {
            if (path == null || !path.startsWith("/k/")) return;
            saveUrl(ORIGIN + path, "attachment; filename=\"" + (name == null ? "Koru file" : name.replace("\"", "")) + "\"", null);
        }
        @JavascriptInterface public int cores() { return Runtime.getRuntime().availableProcessors(); }
        @JavascriptInterface public long memoryMb() {
            android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
            android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            return mi.totalMem / (1024 * 1024);
        }
    }

    // a download link to one of Koru's own files (a .cbz): stream it into Downloads
    private void saveUrl(String url, String disposition, String mime) {
        new Thread(() -> {
            try {
                Uri u = Uri.parse(url);
                if (!HOST.equals(u.getHost())) { openExternal(url); return; }
                WebResourceResponse r = backend.handle("GET", u, new HashMap<>(), null);
                if (r.getStatusCode() != 200) throw new Exception("status " + r.getStatusCode());
                String name = "Koru download";
                String d = disposition;
                if (d == null && r.getResponseHeaders() != null) d = r.getResponseHeaders().get("Content-Disposition");
                if (d != null) { java.util.regex.Matcher m = java.util.regex.Pattern.compile("filename=\"([^\"]+)\"").matcher(d); if (m.find()) name = m.group(1); }
                toastSaved(writeDownload(name, mime == null ? r.getMimeType() : mime, r.getData()));
            } catch (Exception e) { toast("Couldn't save the file: " + e.getMessage(), "error"); }
        }).start();
    }

    private String writeDownload(String name, String mime, InputStream in) throws Exception {
        String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
            v.put(MediaStore.Downloads.MIME_TYPE, mime == null ? "application/octet-stream" : mime);
            v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Koru");
            Uri dest = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (dest == null) throw new Exception("no space for it");
            try (OutputStream out = getContentResolver().openOutputStream(dest); InputStream src = in) { copy(src, out); }
            return "Downloads/Koru/" + safe;
        }
        File dir = new File(getExternalFilesDir(null), "Downloads");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File f = new File(dir, safe);
        try (OutputStream out = new FileOutputStream(f); InputStream src = in) { copy(src, out); }
        share(f, mime);
        return f.getName();
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private void toastSaved(String where) { toast("Saved to " + where, "ok"); }
    private void toast(String msg, String kind) {
        String js = "window.K&&K.toast(" + org.json.JSONObject.quote(msg) + "," + org.json.JSONObject.quote(kind) + ")";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    // ---------- KoruBackend.Opener ----------
    @Override
    public void openExternal(String url) {
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
        runOnUiThread(() -> {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
            catch (Exception e) { toast("No app can open that link.", "error"); }
        });
    }

    @Override
    public void installApk(File apk) {
        runOnUiThread(() -> {
            try {
                if (!getPackageManager().canRequestPackageInstalls()) {
                    toast("Allow Koru to install updates, then tap Update now again.", "info");
                    startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
                    return;
                }
                Uri uri = FileProvider.getUriForFile(this, "app.koru.reader.files", apk);
                Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
            } catch (Exception e) { toast("Couldn't start the update: " + e.getMessage(), "error"); }
        });
    }

    @Override
    public void share(File file, String mime) {
        runOnUiThread(() -> {
            try {
                Uri uri = FileProvider.getUriForFile(this, "app.koru.reader.files", file);
                Intent i = new Intent(Intent.ACTION_SEND).setType(mime == null ? "application/octet-stream" : mime)
                        .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(i, "Share").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception e) { toast("Couldn't share it: " + e.getMessage(), "error"); }
        });
    }
}
