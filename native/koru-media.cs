// Koru's "Now playing" helper: reads what's playing from Windows' own media controls (the ones in the volume
// pop-up), so it works with Glasswave, Spotify, browsers and anything else that shows there.
// It waits for Windows to say something changed (no polling), writes one JSON line per change to stdout,
// and takes commands on stdin: toggle, play, pause, next, prev. Started by Koru, exits when Koru closes stdin.
using System;
using System.IO;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

static class KoruMedia {
  static GlobalSystemMediaTransportControlsSessionManager mgr;
  static GlobalSystemMediaTransportControlsSession cur;
  static readonly object gate = new object();
  static string lastJson = "", lastTrack = "", lastThumb = "";
  static Timer debounce;
  // wait for a Windows operation (these finish in milliseconds)
  static T Wait<T>(IAsyncOperation<T> op, int ms = 5000) { var t0 = Environment.TickCount; while (op.Status == AsyncStatus.Started && Environment.TickCount - t0 < ms) Thread.Sleep(4); if (op.Status != AsyncStatus.Completed) throw new Exception("timed out"); return op.GetResults(); }
  static T Wait<T, P>(IAsyncOperationWithProgress<T, P> op, int ms = 5000) { var t0 = Environment.TickCount; while (op.Status == AsyncStatus.Started && Environment.TickCount - t0 < ms) Thread.Sleep(4); if (op.Status != AsyncStatus.Completed) throw new Exception("timed out"); return op.GetResults(); }

  static string Esc(string s) {
    if (s == null) return "";
    var b = new StringBuilder();
    foreach (var c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 32) b.AppendFormat("\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.ToString();
  }

  static void Watch(GlobalSystemMediaTransportControlsSession s) {
    lock (gate) {
      if (cur != null) { try { cur.MediaPropertiesChanged -= OnProps; cur.PlaybackInfoChanged -= OnPlay; } catch { } }
      cur = s;
      if (cur != null) { cur.MediaPropertiesChanged += OnProps; cur.PlaybackInfoChanged += OnPlay; }
    }
    Soon();
  }
  static void OnProps(GlobalSystemMediaTransportControlsSession s, MediaPropertiesChangedEventArgs e) { Soon(); }
  static void OnPlay(GlobalSystemMediaTransportControlsSession s, PlaybackInfoChangedEventArgs e) { Soon(); }
  // changes come in bursts (title, then artist, then cover): send one update once they settle
  static void Soon() { lock (gate) { if (debounce == null) debounce = new Timer(_ => Send(), null, 250, Timeout.Infinite); else debounce.Change(250, Timeout.Infinite); } }

  static void Send() {
    try {
      GlobalSystemMediaTransportControlsSession s; lock (gate) s = cur;
      string json;
      if (s == null) json = "{\"on\":false}";
      else {
        var p = Wait(s.TryGetMediaPropertiesAsync());
        var info = s.GetPlaybackInfo();
        bool playing = info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        string track = (p.Title ?? "") + "\u0001" + (p.Artist ?? "") + "\u0001" + s.SourceAppUserModelId;
        if (track != lastTrack) { lastTrack = track; lastThumb = Thumb(p.Thumbnail); }
        var c = info.Controls;
        json = "{\"on\":true,\"title\":\"" + Esc(p.Title) + "\",\"artist\":\"" + Esc(p.Artist) + "\",\"album\":\"" + Esc(p.AlbumTitle) +
          "\",\"app\":\"" + Esc(s.SourceAppUserModelId) + "\",\"playing\":" + (playing ? "true" : "false") +
          ",\"canNext\":" + (c.IsNextEnabled ? "true" : "false") + ",\"canPrev\":" + (c.IsPreviousEnabled ? "true" : "false") +
          ",\"thumb\":\"" + lastThumb + "\"}";
      }
      if (json == lastJson) return;
      lastJson = json;
      lock (Console.Out) { Console.Out.WriteLine(json); Console.Out.Flush(); }
    } catch { }
  }

  // the cover picture as a data URL (covers are small; very large ones are skipped)
  static string Thumb(IRandomAccessStreamReference r) {
    if (r == null) return "";
    try {
      using (var st = Wait(r.OpenReadAsync())) {
        if (st.Size == 0 || st.Size > 1500000) return "";
        var buf = new Windows.Storage.Streams.Buffer((uint)st.Size);
        var got = Wait(st.ReadAsync(buf, (uint)st.Size, InputStreamOptions.None));
        var reader = DataReader.FromBuffer(got);
        var bytes = new byte[got.Length]; reader.ReadBytes(bytes);
        string type = st.ContentType;
        if (string.IsNullOrEmpty(type)) type = bytes.Length > 3 && bytes[0] == 0x89 ? "image/png" : "image/jpeg";
        return "data:" + type + ";base64," + Convert.ToBase64String(bytes);
      }
    } catch { return ""; }
  }

  static int Main(string[] args) {
    try {
      Console.OutputEncoding = new UTF8Encoding(false);
      mgr = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
      mgr.CurrentSessionChanged += (m, e) => Watch(m.GetCurrentSession());
      Watch(mgr.GetCurrentSession());
      if (args.Length > 0 && args[0] == "once") { Thread.Sleep(600); Send(); return 0; }
      string line;
      while ((line = Console.In.ReadLine()) != null) {   // Koru closing the pipe ends this helper
        GlobalSystemMediaTransportControlsSession s; lock (gate) s = cur;
        if (s == null) continue;
        try {
          switch (line.Trim()) {
            case "toggle": Wait(s.TryTogglePlayPauseAsync(), 3000); break;
            case "play": Wait(s.TryPlayAsync(), 3000); break;
            case "pause": Wait(s.TryPauseAsync(), 3000); break;
            case "next": Wait(s.TrySkipNextAsync(), 3000); break;
            case "prev": Wait(s.TrySkipPreviousAsync(), 3000); break;
          }
        } catch { }
      }
      return 0;
    } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
  }
}
