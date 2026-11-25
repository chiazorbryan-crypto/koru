package app.koru.reader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
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
    private boolean imeShown = false;
    // the system bars sit over the app's own bars: their space is painted in the colours the page asks for
    private final BarsDrawable bars = new BarsDrawable();
    // the splash screen stays up until the page has drawn its first screen (or a few seconds pass)
    private volatile boolean pageReady = false;
    // a file picker the page opened (<input type=file>: restoring a backup, a wallpaper, importing), waiting for its answer
    private ValueCallback<Uri[]> fileWait;
    private static final int PICK_FILE = 41;
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
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, ua, disposition, mime, length) -> saveUrl(url, disposition, mime));

        // Edge to edge: the page fills the screen, and the system bars' space is kept free with padding
        // (dropped in full-screen reading).
        frame = new FrameLayout(this);
        frame.setBackground(bars);
        frame.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        frame.setOnApplyWindowInsetsListener((v, insets) -> {
            if (immersive) v.setPadding(0, 0, 0, 0);
            else {
                android.graphics.Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(b.left, b.top, b.right, b.bottom);
                bars.setTop(b.top);
            }
            // the page puts its bottom bar away while the keyboard is up
            boolean ime = insets.isVisible(WindowInsets.Type.ime());
            if (ime != imeShown) {
                imeShown = ime;
                web.evaluateJavascript("window.KoruIme&&window.KoruIme(" + ime + ")", null);
            }
            return WindowInsets.CONSUMED;
        });
        getWindow().setDecorFitsSystemWindows(false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) { getWindow().setNavigationBarContrastEnforced(false); getWindow().setStatusBarContrastEnforced(false); }
        setContentView(frame);
        // keep the splash screen (Android 12+) or the plain background up until the page is ready
        final long shown = System.currentTimeMillis();
        frame.getViewTreeObserver().addOnPreDrawListener(new ViewTreeObserver.OnPreDrawListener() {
            @Override public boolean onPreDraw() {
                if (pageReady || System.currentTimeMillis() - shown > 3000) {
                    frame.getViewTreeObserver().removeOnPreDrawListener(this);
                    return true;
                }
                frame.postDelayed(frame::invalidate, 50);
                return false;
            }
        });

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

    // ---------- Android's own dialogs and file picker for the page ----------
    private class Chrome extends WebChromeClient {
        @Override public boolean onJsAlert(WebView v, String url, String msg, JsResult r) {
            new AlertDialog.Builder(MainActivity.this, android.R.style.Theme_DeviceDefault_Dialog_Alert).setMessage(msg)
                    .setPositiveButton(android.R.string.ok, (d, w) -> r.confirm()).setOnCancelListener(d -> r.confirm()).show();
            return true;
        }
        @Override public boolean onJsConfirm(WebView v, String url, String msg, JsResult r) {
            new AlertDialog.Builder(MainActivity.this, android.R.style.Theme_DeviceDefault_Dialog_Alert).setMessage(msg)
                    .setPositiveButton(android.R.string.ok, (d, w) -> r.confirm()).setNegativeButton(android.R.string.cancel, (d, w) -> r.cancel())
                    .setOnCancelListener(d -> r.cancel()).show();
            return true;
        }
        @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
            if (fileWait != null) fileWait.onReceiveValue(null);
            fileWait = cb;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            java.util.List<String> mimes = new java.util.ArrayList<>();
            boolean allMime = true;
            for (String t : p.getAcceptTypes()) { if (t == null || t.trim().isEmpty()) continue; if (t.contains("/")) mimes.add(t.trim()); else allMime = false; }
            if (allMime && !mimes.isEmpty()) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
            if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try { startActivityForResult(i, PICK_FILE); }
            catch (Exception e) { fileWait = null; cb.onReceiveValue(null); toast("No app can pick a file.", "error"); }
            return true;
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == PICK_FILE && fileWait != null) {
            Uri[] got = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    got = new Uri[data.getClipData().getItemCount()];
                    for (int k = 0; k < got.length; k++) got[k] = data.getClipData().getItemAt(k).getUri();
                } else if (data.getData() != null) got = new Uri[] { data.getData() };
            }
            fileWait.onReceiveValue(got);
            fileWait = null;
            return;
        }
        super.onActivityResult(req, res, data);
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
        // the page has drawn its first screen: the splash screen can go
        @JavascriptInterface public void ready() { pageReady = true; runOnUiThread(() -> frame.invalidate()); }
        // the colours behind the status bar (top) and the navigation bar (bottom), as #rrggbb
        @JavascriptInterface public void setBars(String top, String bottom) { runOnUiThread(() -> paintBars(top, bottom)); }
        // a short buzz: tick (a tap or a switch), long (a long-press), confirm, reject
        @JavascriptInterface public void haptic(String kind) {
            runOnUiThread(() -> {
                int c;
                if ("long".equals(kind)) c = HapticFeedbackConstants.LONG_PRESS;
                else if ("confirm".equals(kind)) c = Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.CONTEXT_CLICK;
                else if ("reject".equals(kind)) c = Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
                else c = HapticFeedbackConstants.CLOCK_TICK;
                web.performHapticFeedback(c);
            });
        }
        // Android's share sheet, for a link or some text
        @JavascriptInterface public void shareText(String title, String text) {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                    if (title != null && !title.isEmpty()) i.putExtra(Intent.EXTRA_SUBJECT, title);
                    startActivity(Intent.createChooser(i, title == null || title.isEmpty() ? "Share" : title));
                } catch (Exception e) { toast("Couldn't share it: " + e.getMessage(), "error"); }
            });
        }
        // ... or a file (a picture, say): it's written to the app's cache and handed over
        @JavascriptInterface public void shareFile(String name, String mime, String base64) {
            new Thread(() -> {
                try {
                    File dir = new File(getCacheDir(), "share");
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                    File f = new File(dir, (name == null ? "Koru" : name).replaceAll("[\\\\/:*?\"<>|]", "_"));
                    try (OutputStream out = new FileOutputStream(f)) { out.write(Base64.decode(base64, Base64.DEFAULT)); }
                    share(f, mime);
                } catch (Exception e) { toast("Couldn't share it: " + e.getMessage(), "error"); }
            }).start();
        }
        @JavascriptInterface public int cores() { return Runtime.getRuntime().availableProcessors(); }
        @JavascriptInterface public long memoryMb() {
            android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
            android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            return mi.totalMem / (1024 * 1024);
        }
    }

    // ---------- the system bars ----------
    private void paintBars(String top, String bottom) {
        int t = parseColor(top, bars.top), b = parseColor(bottom, bars.bottom);
        bars.set(t, b);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                int look = (light(t) ? WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0) | (light(b) ? WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS : 0);
                c.setSystemBarsAppearance(look, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            }
        }
    }
    private static int parseColor(String s, int fallback) { try { return Color.parseColor(s); } catch (Exception e) { return fallback; } }
    private static boolean light(int c) { return (0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)) > 150; }

    /** Two flat colours: one behind the status bar, the other everywhere else (the navigation bar). */
    private static class BarsDrawable extends Drawable {
        int top = Color.parseColor("#07081a"), bottom = Color.parseColor("#07081a"), topH = 0;
        private final Paint p = new Paint();
        void set(int t, int b) { if (t == top && b == bottom) return; top = t; bottom = b; invalidateSelf(); }
        void setTop(int h) { if (h == topH) return; topH = h; invalidateSelf(); }
        @Override public void draw(Canvas c) {
            android.graphics.Rect r = getBounds();
            p.setColor(bottom); c.drawRect(r, p);
            if (topH > 0) { p.setColor(top); c.drawRect(r.left, r.top, r.right, r.top + topH, p); }
        }
        @Override public void setAlpha(int a) {}
        @Override public void setColorFilter(ColorFilter f) {}
        @Override public int getOpacity() { return PixelFormat.OPAQUE; }
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
