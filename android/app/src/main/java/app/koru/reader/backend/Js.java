package app.koru.reader.backend;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/** Small helpers that behave like the JavaScript the desktop backend is written in. */
final class Js {
  private Js() {}

  /** JavaScript truthiness for values that came out of org.json. */
  static boolean truthy(Object o) {
    if (o == null || o == JSONObject.NULL) return false;
    if (o instanceof Boolean) return (Boolean) o;
    if (o instanceof Number) { double d = ((Number) o).doubleValue(); return d != 0 && !Double.isNaN(d); }
    if (o instanceof String) return !((String) o).isEmpty();
    return true;
  }

  /** JavaScript String(x). */
  static String str(Object o) {
    if (o == null) return "undefined";
    if (o == JSONObject.NULL) return "null";
    if (o instanceof Integer || o instanceof Long || o instanceof Short || o instanceof Byte) return o.toString();
    if (o instanceof Number) return num(((Number) o).doubleValue());
    if (o instanceof JSONObject) return "[object Object]";
    if (o instanceof JSONArray) {
      JSONArray a = (JSONArray) o; StringBuilder sb = new StringBuilder();
      for (int i = 0; i < a.length(); i++) { if (i > 0) sb.append(','); Object v = a.opt(i); if (v != null && v != JSONObject.NULL) sb.append(str(v)); }
      return sb.toString();
    }
    return o.toString();
  }

  /** How JavaScript prints a number (12, 12.5, not 12.0). */
  static String num(double d) {
    if (Double.isNaN(d)) return "NaN";
    if (Double.isInfinite(d)) return d > 0 ? "Infinity" : "-Infinity";
    if (d == Math.rint(d) && Math.abs(d) < 1e21) return Long.toString((long) d);
    try { return new BigDecimal(Double.toString(d)).stripTrailingZeros().toPlainString(); } catch (Exception e) { return Double.toString(d); }
  }

  /** a ?? b for org.json values (null and JSONObject.NULL both count as missing). */
  static Object nullish(Object o) { return o == null || o == JSONObject.NULL ? null : o; }

  static String pad4(int n) { String s = Integer.toString(n); while (s.length() < 4) s = "0" + s; return s; }

  /** encodeURIComponent */
  static String encodeURIComponent(String s) {
    if (s == null) return "";
    byte[] b = s.getBytes(StandardCharsets.UTF_8);
    StringBuilder sb = new StringBuilder(b.length + 8);
    for (byte x : b) {
      int c = x & 0xFF;
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
          || c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')') sb.append((char) c);
      else { sb.append('%'); sb.append(Character.toUpperCase(Character.forDigit(c >> 4, 16))); sb.append(Character.toUpperCase(Character.forDigit(c & 15, 16))); }
    }
    return sb.toString();
  }

  /** Percent-decoding like decodeURIComponent; bad sequences are left as they are instead of throwing. */
  static String decodeComponent(String s, boolean plusIsSpace) {
    if (s == null) return null;
    String t = plusIsSpace ? s : s.replace("+", "%2B");
    try { return URLDecoder.decode(t, "UTF-8"); } catch (Exception e) { return plusIsSpace ? s.replace('+', ' ') : s; }
  }

  /** URLSearchParams.get for every name (first value wins). */
  static Map<String, String> query(String encodedQuery) {
    Map<String, String> m = new HashMap<>();
    if (encodedQuery == null || encodedQuery.isEmpty()) return m;
    for (String part : encodedQuery.split("&")) {
      if (part.isEmpty()) continue;
      int eq = part.indexOf('=');
      String k = decodeComponent(eq < 0 ? part : part.substring(0, eq), true);
      String v = eq < 0 ? "" : decodeComponent(part.substring(eq + 1), true);
      if (k != null && !m.containsKey(k)) m.put(k, v);
    }
    return m;
  }

  /** JSON.parse: any JSON value (object, array, string, number, true/false/null); throws on junk. */
  static Object parseJson(String text) throws JSONException {
    if (text == null) throw new JSONException("Unexpected end of JSON input");
    String t = text.trim();
    if (t.isEmpty()) throw new JSONException("Unexpected end of JSON input");
    char c = t.charAt(0);
    if ("{[\"-0123456789tfn".indexOf(c) < 0) throw new JSONException("Unexpected token " + c + " in JSON");
    JSONTokener tok = new JSONTokener(t);
    Object v = tok.nextValue();
    if (tok.nextClean() != 0) throw new JSONException("Unexpected data after JSON");
    if (v instanceof String && c != '"') throw new JSONException("Unexpected token in JSON");
    return v;
  }

  /** JSON.parse(text || '{}') expecting an object; anything that isn't an object becomes an empty one. */
  static JSONObject parseBody(String text) throws JSONException {
    Object v = parseJson(text == null || text.isEmpty() ? "{}" : text);
    return v instanceof JSONObject ? (JSONObject) v : new JSONObject();
  }

  /** Builds a JSONObject from name/value pairs; a Java null becomes JSON null. */
  static JSONObject obj(Object... kv) {
    JSONObject o = new JSONObject();
    try {
      for (int i = 0; i + 1 < kv.length; i += 2) {
        Object v = kv[i + 1];
        if (v instanceof Double && (((Double) v).isNaN() || ((Double) v).isInfinite())) v = null;
        o.put((String) kv[i], v == null ? JSONObject.NULL : v);
      }
    } catch (JSONException e) { throw new IllegalStateException(e); }
    return o;
  }

  static void put(JSONObject o, String k, Object v) {
    try { o.put(k, v == null ? JSONObject.NULL : v); } catch (JSONException e) { throw new IllegalStateException(e); }
  }

  /** String.prototype.localeCompare(b, undefined, { numeric: true }), close enough for file and chapter names. */
  static int naturalCompare(String a, String b) {
    if (a == null) a = ""; if (b == null) b = "";
    int i = 0, j = 0, na = a.length(), nb = b.length();
    while (i < na && j < nb) {
      char ca = a.charAt(i), cb = b.charAt(j);
      if (Character.isDigit(ca) && Character.isDigit(cb)) {
        int si = i, sj = j;
        while (i < na && Character.isDigit(a.charAt(i))) i++;
        while (j < nb && Character.isDigit(b.charAt(j))) j++;
        String da = a.substring(si, i).replaceFirst("^0+(?=.)", ""), db = b.substring(sj, j).replaceFirst("^0+(?=.)", "");
        if (da.length() != db.length()) return da.length() - db.length();
        int c = da.compareTo(db);
        if (c != 0) return c;
      } else {
        int c = Character.compare(Character.toLowerCase(ca), Character.toLowerCase(cb));
        if (c != 0) return c;
        i++; j++;
      }
    }
    int c = (na - i) - (nb - j);
    return c != 0 ? c : a.compareTo(b);
  }

  // ---------- files ----------
  private static final AtomicLong TMP_SEQ = new AtomicLong();

  /** Write to a temp file next to the target, then rename over it (atomic on the same filesystem). */
  static void writeAtomic(File file, byte[] data) throws IOException {
    File dir = file.getParentFile();
    if (dir != null && !dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) throw new IOException("Couldn't create " + dir);
    File tmp = new File(dir, file.getName() + "." + android.os.Process.myPid() + "-" + TMP_SEQ.incrementAndGet() + ".tmp");
    try {
      try (FileOutputStream out = new FileOutputStream(tmp)) {
        out.write(data);
        out.getFD().sync();
      }
      if (!tmp.renameTo(file)) throw new IOException("Couldn't save " + file.getName());
    } finally {
      if (tmp.exists()) //noinspection ResultOfMethodCallIgnored
        tmp.delete();
    }
  }

  static byte[] readFile(File f, long max) throws IOException {
    try (InputStream in = new FileInputStream(f)) { return readAll(in, max); }
  }

  static String readText(File f) throws IOException { return new String(readFile(f, 64L << 20), StandardCharsets.UTF_8); }

  /** JSON.parse(readFile(f)) as an object, or null when missing / not JSON / not an object. */
  static JSONObject readJsonObject(File f) {
    try { Object v = parseJson(readText(f)); return v instanceof JSONObject ? (JSONObject) v : null; } catch (Exception e) { return null; }
  }

  static byte[] readAll(InputStream in, long max) throws IOException {
    ByteArrayOutputStream bo = new ByteArrayOutputStream(16 * 1024);
    byte[] buf = new byte[32 * 1024];
    long total = 0;
    int n;
    while ((n = in.read(buf)) != -1) {
      total += n;
      if (total > max) throw new IOException("Too large");
      bo.write(buf, 0, n);
    }
    return bo.toByteArray();
  }

  /** True when f is a symbolic link (its canonical path isn't its parent's canonical path + its name). */
  static boolean isSymlink(File f) {
    try {
      File parent = f.getParentFile();
      if (parent == null) return false;
      File plain = new File(parent.getCanonicalFile(), f.getName());
      return !plain.getCanonicalPath().equals(plain.getAbsolutePath());
    } catch (IOException e) { return true; }
  }

  /** rm -rf that never follows links out of the tree. */
  static void deleteRecursive(File f) {
    if (f == null) return;
    if (f.isDirectory() && !isSymlink(f)) {
      File[] kids = f.listFiles();
      if (kids != null) for (File k : kids) deleteRecursive(k);
    }
    //noinspection ResultOfMethodCallIgnored
    f.delete();
  }

  static String lower(String s) { return s == null ? "" : s.toLowerCase(Locale.ROOT); }

  static String message(Throwable t, String fallback) {
    String m = t == null ? null : t.getMessage();
    return m == null || m.isEmpty() ? fallback : m;
  }

  static void sleep(long ms) throws IOException {
    try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("Interrupted"); }
  }
}
