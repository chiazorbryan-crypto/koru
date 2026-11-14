package app.koru.reader.backend;

import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** One answer to the page, turned into a WebResourceResponse at the end. */
final class Res {
  static final String NO_STORE = "no-store";
  static final String FILE_CACHE = "max-age=86400";

  int status;
  String type;
  byte[] bytes;
  InputStream stream;
  String cache = NO_STORE;
  final Map<String, String> headers = new LinkedHashMap<>();

  Res(int status, String type, byte[] bytes) { this.status = status; this.type = type; this.bytes = bytes; }

  Res(int status, String type, InputStream stream) { this.status = status; this.type = type; this.stream = stream; }

  static Res json(int status, Object body) {
    String s = body instanceof JSONObject || body instanceof JSONArray ? body.toString() : String.valueOf(body);
    return new Res(status, "application/json", s.getBytes(StandardCharsets.UTF_8));
  }

  static Res error(int status, String message) { return json(status, Js.obj("error", message)); }

  static Res ok() { return json(200, Js.obj("ok", true)); }

  WebResourceResponse toWeb() {
    int st = status;
    byte[] b = bytes;
    InputStream in = stream;
    String t = type == null || type.isEmpty() ? "application/octet-stream" : type;
    // WebResourceResponse refuses 3xx and anything outside 100-599.
    if (st < 100 || st > 599 || (st >= 300 && st <= 399)) {
      closeQuietly(in);
      in = null;
      st = 502;
      t = "application/json";
      b = Js.obj("error", "The site redirected somewhere unexpected.").toString().getBytes(StandardCharsets.UTF_8);
    }
    if (in == null) in = new ByteArrayInputStream(b == null ? new byte[0] : b);
    String mime = t, charset = null;
    int semi = t.indexOf(';');
    if (semi >= 0) {
      mime = t.substring(0, semi).trim();
      for (String p : t.substring(semi + 1).split(";")) {
        String q = p.trim();
        if (q.toLowerCase(Locale.ROOT).startsWith("charset=")) charset = q.substring(8).replace("\"", "").trim();
      }
    }
    if (mime.isEmpty()) mime = "application/octet-stream";
    if (charset == null && (mime.equals("application/json") || mime.startsWith("text/"))) charset = "utf-8";
    Map<String, String> h = new LinkedHashMap<>();
    h.put("Content-Type", t.equals("application/json") ? "application/json; charset=utf-8" : t);
    h.put("Cache-Control", cache == null ? NO_STORE : cache);
    h.put("Access-Control-Allow-Origin", "*");
    if (b != null && stream == null) h.put("Content-Length", Integer.toString(b.length));
    h.putAll(headers);
    return new WebResourceResponse(mime, charset, st, reason(st), h, in);
  }

  static String reason(int s) {
    switch (s) {
      case 200: return "OK";
      case 201: return "Created";
      case 204: return "No Content";
      case 206: return "Partial Content";
      case 400: return "Bad Request";
      case 401: return "Unauthorized";
      case 403: return "Forbidden";
      case 404: return "Not Found";
      case 405: return "Method Not Allowed";
      case 409: return "Conflict";
      case 410: return "Gone";
      case 422: return "Unprocessable Entity";
      case 429: return "Too Many Requests";
      case 500: return "Internal Server Error";
      case 502: return "Bad Gateway";
      case 503: return "Service Unavailable";
      case 504: return "Gateway Timeout";
      default:
        if (s < 200) return "Info";
        if (s < 300) return "OK";
        if (s < 500) return "Client Error";
        return "Server Error";
    }
  }

  static void closeQuietly(java.io.Closeable c) {
    if (c != null) try { c.close(); } catch (Exception ignored) {}
  }
}
