package app.koru.reader.backend;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.zip.CRC32;

/**
 * A tiny ZIP writer (STORE only, no compression: comic pages are already compressed), the same layout as the
 * desktop's zipStream. Files are read one at a time (once for the CRC, once to copy), so a whole series never sits
 * in memory. Zip64 kicks in past 4 GB / 65535 files.
 */
final class CbzWriter {
  private CbzWriter() {}

  static final class Entry {
    final String name;
    final File file;
    final byte[] data;
    Entry(String name, File file) { this.name = name; this.file = file; this.data = null; }
    Entry(String name, byte[] data) { this.name = name; this.file = null; this.data = data; }
  }

  private static final class Central { byte[] name; long crc, size, offset; }

  static void write(List<Entry> entries, OutputStream out) throws IOException {
    Calendar d = Calendar.getInstance();
    int time = (d.get(Calendar.HOUR_OF_DAY) << 11) | (d.get(Calendar.MINUTE) << 5) | (d.get(Calendar.SECOND) >> 1);
    int date = ((Math.max(1980, d.get(Calendar.YEAR)) - 1980) << 9) | ((d.get(Calendar.MONTH) + 1) << 5) | d.get(Calendar.DAY_OF_MONTH);
    List<Central> central = new ArrayList<>();
    long offset = 0;
    byte[] buf = new byte[64 * 1024];
    for (Entry e : entries) {
      byte[] name = e.name.getBytes(StandardCharsets.UTF_8);
      long size, crc;
      if (e.data != null) {
        size = e.data.length;
        CRC32 c = new CRC32(); c.update(e.data); crc = c.getValue();
      } else {
        size = e.file.length();
        CRC32 c = new CRC32();
        long read = 0;
        try (InputStream in = new FileInputStream(e.file)) {
          int n;
          while ((n = in.read(buf)) != -1) { c.update(buf, 0, n); read += n; }
        }
        if (read != size) throw new IOException("A page changed while it was being exported.");
        crc = c.getValue();
      }
      ByteBuffer h = le(30);
      h.putInt(0x04034b50).putShort((short) 20).putShort((short) 0x0800).putShort((short) 0).putShort((short) time).putShort((short) date)
        .putInt((int) crc).putInt((int) size).putInt((int) size).putShort((short) name.length).putShort((short) 0);
      out.write(h.array());
      out.write(name);
      if (e.data != null) out.write(e.data);
      else {
        long left = size;
        try (InputStream in = new FileInputStream(e.file)) {
          int n;
          while (left > 0 && (n = in.read(buf, 0, (int) Math.min(buf.length, left))) != -1) { out.write(buf, 0, n); left -= n; }
        }
        if (left != 0) throw new IOException("A page changed while it was being exported.");
      }
      Central c = new Central();
      c.name = name; c.crc = crc; c.size = size; c.offset = offset;
      central.add(c);
      offset += 30 + name.length + size;
    }

    long cdStart = offset;
    ByteArrayOutputStream cd = new ByteArrayOutputStream();
    for (Central c : central) {
      boolean big = c.offset >= 0xFFFFFFFFL;
      byte[] x = null;
      if (big) { ByteBuffer xb = le(12); xb.putShort((short) 0x0001).putShort((short) 8).putLong(c.offset); x = xb.array(); }
      ByteBuffer h = le(46);
      h.putInt(0x02014b50).putShort((short) (big ? 45 : 20)).putShort((short) (big ? 45 : 20)).putShort((short) 0x0800).putShort((short) 0)
        .putShort((short) time).putShort((short) date).putInt((int) c.crc).putInt((int) c.size).putInt((int) c.size)
        .putShort((short) c.name.length).putShort((short) (x != null ? x.length : 0)).putShort((short) 0).putShort((short) 0).putShort((short) 0)
        .putInt(0).putInt(big ? 0xFFFFFFFF : (int) c.offset);
      cd.write(h.array());
      cd.write(c.name);
      if (x != null) cd.write(x);
    }
    long cdSize = cd.size(), n = central.size();
    out.write(cd.toByteArray());
    boolean z64 = n >= 0xFFFF || cdStart >= 0xFFFFFFFFL || cdSize >= 0xFFFFFFFFL;
    if (z64) {
      long zEnd = cdStart + cdSize;
      ByteBuffer r = le(56);
      r.putInt(0x06064b50).putLong(44).putShort((short) 45).putShort((short) 45).putInt(0).putInt(0)
        .putLong(n).putLong(n).putLong(cdSize).putLong(cdStart);
      out.write(r.array());
      ByteBuffer l = le(20);
      l.putInt(0x07064b50).putInt(0).putLong(zEnd).putInt(1);
      out.write(l.array());
    }
    ByteBuffer e = le(22);
    e.putInt(0x06054b50).putShort((short) 0).putShort((short) 0).putShort((short) Math.min(n, 0xFFFF)).putShort((short) Math.min(n, 0xFFFF))
      .putInt((int) Math.min(cdSize, 0xFFFFFFFFL)).putInt((int) Math.min(cdStart, 0xFFFFFFFFL)).putShort((short) 0);
    out.write(e.array());
    out.flush();
  }

  private static ByteBuffer le(int n) { return ByteBuffer.allocate(n).order(ByteOrder.LITTLE_ENDIAN); }

  private static String xmlEsc(String s) {
    StringBuilder sb = new StringBuilder(s.length() + 16);
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '<': sb.append("&lt;"); break;
        case '>': sb.append("&gt;"); break;
        case '&': sb.append("&amp;"); break;
        case '"': sb.append("&quot;"); break;
        case '\'': sb.append("&apos;"); break;
        default:
          if (c <= 0x08 || c == 0x0B || c == 0x0C || (c >= 0x0E && c <= 0x1F)) break;
          sb.append(c);
      }
    }
    return sb.toString();
  }

  /** ComicInfo.xml (the Anansi/ComicRack format most comic readers understand). fields: name, value, name, value... */
  static String comicInfo(Object... fields) {
    StringBuilder sb = new StringBuilder("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<ComicInfo xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\">\n");
    for (int i = 0; i + 1 < fields.length; i += 2) {
      Object v = fields[i + 1];
      if (v == null) continue;
      String s = v instanceof Number ? Js.str(v) : String.valueOf(v);
      if (s.isEmpty()) continue;
      sb.append("  <").append(fields[i]).append('>').append(xmlEsc(s)).append("</").append(fields[i]).append(">\n");
    }
    return sb.append("</ComicInfo>\n").toString();
  }
}
