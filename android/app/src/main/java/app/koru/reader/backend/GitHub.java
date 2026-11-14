package app.koru.reader.backend;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Plain HTTPS calls to the GitHub API (sync and app updates). The key is only ever sent to the API host itself. */
final class GitHub {
  private GitHub() {}

  static final String UA = "Koru-app";
  static final String API_VERSION = "2022-11-28";

  static final class Answer {
    final int status;
    final String text;
    Answer(int status, String text) { this.status = status; this.text = text; }
    boolean ok() { return status >= 200 && status < 300; }
  }

  static String host(String u) {
    try { return new URL(u).getHost().toLowerCase(java.util.Locale.ROOT); } catch (Exception e) { return ""; }
  }

  /** One request; GET redirects are followed by hand, and the key is dropped as soon as the host changes. */
  static Answer call(String url, String method, byte[] body, String key, String accept, int timeoutMs) throws IOException {
    String cur = url;
    String apiHost = host(url);
    for (int hop = 0; hop < 5; hop++) {
      HttpURLConnection c = (HttpURLConnection) new URL(cur).openConnection();
      try {
        c.setInstanceFollowRedirects(false);
        c.setUseCaches(false);
        c.setConnectTimeout(timeoutMs);
        c.setReadTimeout(timeoutMs);
        c.setRequestMethod(method);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("X-GitHub-Api-Version", API_VERSION);
        c.setRequestProperty("Accept", accept);
        if (key != null && host(cur).equals(apiHost)) c.setRequestProperty("Authorization", "Bearer " + key);
        if (body != null) {
          c.setDoOutput(true);
          c.setRequestProperty("Content-Type", "application/json");
          c.setFixedLengthStreamingMode(body.length);
          try (OutputStream os = c.getOutputStream()) { os.write(body); }
        }
        int code = c.getResponseCode();
        if (code < 0) throw new IOException("Bad answer from GitHub");
        if ((code == 301 || code == 302 || code == 303 || code == 307 || code == 308) && "GET".equals(method)) {
          String loc = c.getHeaderField("Location");
          String next = null;
          try { if (loc != null) next = new URL(new URL(cur), loc).toString(); } catch (Exception ignored) {}
          if (next == null || !next.startsWith("https://")) throw new IOException("Unexpected address from GitHub");
          cur = next;
          continue;
        }
        InputStream in;
        try { in = code >= 400 ? c.getErrorStream() : c.getInputStream(); } catch (IOException e) { in = null; if (code < 400) throw e; }
        String text = "";
        if (in != null) try (InputStream s = in) { text = new String(Js.readAll(s, 32L << 20), StandardCharsets.UTF_8); }
        return new Answer(code, text);
      } finally {
        c.disconnect();
      }
    }
    throw new IOException("Too many redirects from GitHub");
  }
}
