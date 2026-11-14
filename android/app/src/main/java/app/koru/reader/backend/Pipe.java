package app.koru.reader.backend;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * A bounded in-memory pipe between a writer thread and the WebView thread that reads the response.
 * Like PipedInputStream/PipedOutputStream, but it doesn't care which threads read or write (WebView may read from
 * different threads), and a writer whose reader went away (closed, or stopped reading for STALL_MS) gets an
 * IOException instead of blocking forever.
 */
final class Pipe {
  private static final long STALL_MS = 3 * 60 * 1000;
  private final byte[] buf;
  private int r, w, count;
  private boolean writerClosed, readerClosed, failed;
  private final Object lock = new Object();

  Pipe(int size) { buf = new byte[size]; }

  /** The writer gave up: the reader gets an error (after what was already written) instead of a clean end. */
  void fail() { synchronized (lock) { failed = true; writerClosed = true; lock.notifyAll(); } }

  final InputStream in = new InputStream() {
    @Override public int read() throws IOException {
      byte[] one = new byte[1];
      int n = read(one, 0, 1);
      return n < 0 ? -1 : one[0] & 0xFF;
    }

    @Override public int read(byte[] b, int off, int len) throws IOException {
      if (len == 0) return 0;
      synchronized (lock) {
        while (count == 0 && !writerClosed && !readerClosed) {
          try { lock.wait(1000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("Interrupted"); }
        }
        if (readerClosed) throw new IOException("Pipe closed");
        if (count == 0 && failed) throw new IOException("The export failed");
        if (count == 0) return -1;
        int n = Math.min(len, count);
        int first = Math.min(n, buf.length - r);
        System.arraycopy(buf, r, b, off, first);
        if (n > first) System.arraycopy(buf, 0, b, off + first, n - first);
        r = (r + n) % buf.length;
        count -= n;
        lock.notifyAll();
        return n;
      }
    }

    @Override public int available() { synchronized (lock) { return count; } }

    @Override public void close() { synchronized (lock) { readerClosed = true; lock.notifyAll(); } }
  };

  final OutputStream out = new OutputStream() {
    @Override public void write(int b) throws IOException { write(new byte[]{(byte) b}, 0, 1); }

    @Override public void write(byte[] b, int off, int len) throws IOException {
      synchronized (lock) {
        while (len > 0) {
          long since = System.currentTimeMillis();
          while (count == buf.length && !readerClosed) {
            if (System.currentTimeMillis() - since > STALL_MS) { readerClosed = true; throw new IOException("Nobody is reading"); }
            try { lock.wait(1000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("Interrupted"); }
          }
          if (readerClosed) throw new IOException("Pipe closed");
          if (writerClosed) throw new IOException("Pipe closed");
          int n = Math.min(len, buf.length - count);
          int first = Math.min(n, buf.length - w);
          System.arraycopy(b, off, buf, w, first);
          if (n > first) System.arraycopy(b, off + first, buf, 0, n - first);
          w = (w + n) % buf.length;
          count += n;
          off += n;
          len -= n;
          lock.notifyAll();
        }
      }
    }

    @Override public void close() { synchronized (lock) { writerClosed = true; lock.notifyAll(); } }
  };
}
