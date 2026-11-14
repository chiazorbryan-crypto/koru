package app.koru.reader.backend;

/** An error with the HTTP status the page should get (like `Object.assign(new Error(msg), { status })` on the desktop). */
final class KError extends Exception {
  private static final long serialVersionUID = 1L;
  final int status;
  /** final: don't retry (e.g. a redirect to a site that isn't allowed). */
  final boolean fin;

  KError(int status, String message) { this(status, message, false); }

  KError(int status, String message, boolean fin) {
    super(message);
    this.status = status;
    this.fin = fin;
  }
}
