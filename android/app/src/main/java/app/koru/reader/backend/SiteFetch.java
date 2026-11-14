package app.koru.reader.backend;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.zip.GZIPInputStream;

/** Requests to the scan sites: only the allowed sites, the right Referer, retries on slow or patchy connections. */
final class SiteFetch {
  private SiteFetch() {}

  static final String USER_AGENT = "Koru/0.1 (personal reader)";
  /** Image servers that only serve pictures to their own site get that site as Referer (what its own pages send). */
  static final String[][] REFERERS = {
    {"pstatic.net", "https://www.webtoons.com/"}, {"tnlycdn.com", "https://toonily.com/"},
    {"cmzcdn.org", "https://comizy.io/"}, {"readdetectiveconan.com", "https://mangapill.com/"}
  };
  /** Only these sites (and their subdomains) can be reached through Koru. */
  static final String[] ALLOWED = {"omegascans.org", "vortexscans.org", "asurascans.com", "flamecomics.xyz", "mangadex.org", "mangadex.network",
    "webtoons.com", "pstatic.net", "toonily.com", "tnlycdn.com",
    "weebcentral.com", "compsci88.com", "planeptune.us", "lastation.us", "lowee.us", "leanbox.us",
    "comizy.io", "cmzcdn.org", "hivetoons.org", "hivetoon.com",
    "en-thunderscans.com", "madarascans.net", "wp.com", "kingofshojo.com", "violetmanga.com", "drakecomic.net", "ibb.co",
    "qimanga.com", "qiscans.org", "nyxscans.com", "magustoon.org", "rokaricomics.com", "elftoon.net", "elftoon.com",
    "mangapill.com", "readdetectiveconan.com", "lagoonscans.com", "mangaread.org", "manhuaplus.com", "files.wordpress.com"};

  private static final int ATTEMPT_MS = 45000;
  private static final int[] BUSY = {502, 503, 504, 522, 524};

  /**
   * The host of an https URL, lower-cased, or null when the URL is unusable. URLs that different parsers could read
   * differently (backslashes, user info, control characters, odd host characters) are refused, so the host we check
   * is always the host we connect to.
   */
  static String httpsHost(String u) {
    if (u == null || u.isEmpty() || u.length() > 8192) return null;
    for (int i = 0; i < u.length(); i++) {
      char c = u.charAt(i);
      if (c <= 0x20 || c == 0x7F || c == '\\') return null;
    }
    try {
      URL url = new URL(u);
      if (!"https".equalsIgnoreCase(url.getProtocol())) return null;
      if (url.getUserInfo() != null) return null;
      String host = url.getHost();
      if (host == null || host.isEmpty() || !host.matches("[A-Za-z0-9.-]+")) return null;
      host = host.toLowerCase(Locale.ROOT);
      String auth = url.getAuthority() == null ? "" : url.getAuthority().toLowerCase(Locale.ROOT);
      if (!auth.equals(host) && !auth.equals(host + ":" + url.getPort())) return null;
      return host;
    } catch (Exception e) {
      return null;
    }
  }

  static boolean hostIn(String host, String d) { return host.equals(d) || host.endsWith("." + d); }

  static boolean allowedUrl(String u) {
    String h = httpsHost(u);
    if (h == null) return false;
    for (String d : ALLOWED) if (hostIn(h, d)) return true;
    return false;
  }

  static String refererFor(String u) {
    String h = httpsHost(u);
    if (h == null) return null;
    for (String[] r : REFERERS) if (hostIn(h, r[0])) return r[1];
    return null;
  }

  /** "/k/fetch?u=<url>" (images routed through Koru) back to the real url. */
  static String unwrap(String u) {
    if (u != null && u.startsWith("/k/fetch?")) {
      String v = Js.query(u.substring(9)).get("u");
      return v == null ? "" : v;
    }
    return u;
  }

  private static boolean busy(int s) { for (int b : BUSY) if (b == s) return true; return false; }

  /** Slow or patchy connections: wait longer and try again before giving up. The caller closes the result. */
  static Resp fetch(String u, String accept) throws KError, IOException {
    if (!allowedUrl(u)) throw new KError(403, "That site is not one of Koru's sources.");
    for (int attempt = 0; attempt < 3; attempt++) {
      try {
        Resp r = open(u, accept);
        if (busy(r.status) && attempt < 2) {
          r.close();
          Js.sleep(1500L * (attempt + 1));
          continue;
        }
        return r;
      } catch (KError e) {
        throw e;
      } catch (IOException | RuntimeException e) {
        if (Thread.currentThread().isInterrupted()) throw new IOException("Interrupted");
        if (attempt < 2) Js.sleep(1200L * (attempt + 1));
      }
    }
    throw unreachable(u);
  }

  static KError unreachable(String u) {
    String host = httpsHost(u);
    host = host == null ? "the site" : host.replaceFirst("^api\\.", "");
    return new KError(504, "Couldn't reach " + host + ". Your connection may be slow, or the site may be down. Try again in a moment.");
  }

  /** One attempt; redirects are followed by hand and only to allowed sites. */
  private static Resp open(String u, String accept) throws KError, IOException {
    long deadline = System.currentTimeMillis() + ATTEMPT_MS;
    String ref = refererFor(u);
    String cur = u;
    for (int hop = 0; hop < 8; hop++) {
      int left = (int) Math.max(1000, deadline - System.currentTimeMillis());
      HttpURLConnection c = (HttpURLConnection) new URL(cur).openConnection();
      int code;
      try {
        c.setInstanceFollowRedirects(false);
        c.setUseCaches(false);
        c.setConnectTimeout(Math.min(20000, left));
        c.setReadTimeout(left);
        c.setRequestProperty("User-Agent", USER_AGENT);
        c.setRequestProperty("Accept", accept == null || accept.isEmpty() ? "application/json" : accept);
        c.setRequestProperty("Accept-Encoding", "gzip");
        if (ref != null) c.setRequestProperty("Referer", ref);
        code = c.getResponseCode();
        if (code < 0) throw new IOException("Bad answer from the site");
      } catch (IOException | RuntimeException e) {
        c.disconnect();
        throw e;
      }
      if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
        String loc = c.getHeaderField("Location");
        c.disconnect();
        String next = null;
        try { if (loc != null) next = new URL(new URL(cur), loc).toString(); } catch (Exception ignored) {}
        if (next == null || !allowedUrl(next)) throw new KError(502, "The site redirected somewhere unexpected.", true);
        cur = next;
        if (ref == null) ref = refererFor(cur);
        if (System.currentTimeMillis() > deadline) throw new IOException("Timed out");
        continue;
      }
      return new Resp(c, code, cur, deadline);
    }
    throw new KError(502, "The site redirected somewhere unexpected.", true);
  }

  /** An open answer from a site. Read the body once, then close. */
  static final class Resp implements Closeable {
    final HttpURLConnection conn;
    final int status;
    final String url;
    final String type;
    private final long deadline;
    private InputStream in;
    private boolean consumed;

    Resp(HttpURLConnection conn, int status, String url, long deadline) {
      this.conn = conn;
      this.status = status;
      this.url = url;
      this.deadline = deadline;
      this.type = conn.getContentType();
    }

    boolean ok() { return status >= 200 && status < 300; }

    /** content-type without parameters, lower-cased. */
    String mime() {
      if (type == null) return "";
      int i = type.indexOf(';');
      return (i < 0 ? type : type.substring(0, i)).trim().toLowerCase(Locale.ROOT);
    }

    private InputStream body() throws IOException {
      if (in != null) return in;
      InputStream raw;
      try { raw = status >= 400 ? conn.getErrorStream() : conn.getInputStream(); } catch (IOException e) { if (status >= 400) raw = null; else throw e; }
      if (raw == null) raw = new ByteArrayInputStream(new byte[0]);
      if ("gzip".equalsIgnoreCase(conn.getContentEncoding())) {
        InputStream b = new BufferedInputStream(raw);
        try { raw = new GZIPInputStream(b, 16 * 1024); } catch (EOFException empty) { b.close(); raw = new ByteArrayInputStream(new byte[0]); }
      }
      in = raw;
      return in;
    }

    byte[] readAll(long max) throws IOException {
      java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream(32 * 1024);
      copyTo(bo, max);
      return bo.toByteArray();
    }

    /** Copies the body; gives up past the attempt's time limit or `max` bytes. */
    long copyTo(OutputStream out, long max) throws IOException {
      InputStream s = body();
      byte[] buf = new byte[32 * 1024];
      long total = 0;
      int n;
      while ((n = s.read(buf)) != -1) {
        total += n;
        if (total > max) throw new IOException("The answer was too large.");
        if (System.currentTimeMillis() > deadline) throw new IOException("Timed out");
        out.write(buf, 0, n);
      }
      consumed = true;
      return total;
    }

    @Override public void close() {
      try { if (in != null) in.close(); else if (!consumed) { InputStream s = status >= 400 ? conn.getErrorStream() : null; if (s != null) s.close(); } } catch (Exception ignored) {}
      if (!consumed) conn.disconnect();   // a half-read connection can't go back to the pool
    }
  }
}
