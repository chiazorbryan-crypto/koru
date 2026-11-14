package app.koru.reader.backend;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.Key;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * GitHub keys, kept in SharedPreferences encrypted with an AES-GCM key that lives in the Android Keystore
 * (it never leaves the secure hardware / keystore daemon). Never stored in plain text.
 */
final class SecretStore {
  static final String PROTECT_ERROR = "Android can't protect the key on this device, so it wasn't saved.";
  private static final String ALIAS = "koru-secrets-v1";
  private static final String STORE = "AndroidKeyStore";
  private final SharedPreferences prefs;

  SecretStore(Context ctx) { prefs = ctx.getSharedPreferences("koru-secure", Context.MODE_PRIVATE); }

  private SecretKey key() throws Exception {
    KeyStore ks = KeyStore.getInstance(STORE);
    ks.load(null);
    Key k = ks.getKey(ALIAS, null);
    if (k instanceof SecretKey) return (SecretKey) k;
    KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
    g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .build());
    return g.generateKey();
  }

  /** The saved value, or null when there is none or it can't be read any more. */
  synchronized String get(String name) {
    String v = prefs.getString(name, null);
    if (v == null) return null;
    try {
      int i = v.indexOf(':');
      if (i <= 0) return null;
      byte[] iv = Base64.decode(v.substring(0, i), Base64.NO_WRAP);
      byte[] ct = Base64.decode(v.substring(i + 1), Base64.NO_WRAP);
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
      String s = new String(c.doFinal(ct), StandardCharsets.UTF_8);
      return s.isEmpty() ? null : s;
    } catch (Throwable t) {
      return null;
    }
  }

  /** Saves (or with null/empty, removes) a value. Throws with PROTECT_ERROR when the keystore can't be used. */
  synchronized void set(String name, String value) throws Exception {
    if (value == null || value.isEmpty()) { prefs.edit().remove(name).commit(); return; }
    String enc;
    try {
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.ENCRYPT_MODE, key());
      byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
      enc = Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
    } catch (Throwable t) {
      throw new Exception(PROTECT_ERROR);
    }
    if (!prefs.edit().putString(name, enc).commit()) throw new Exception(PROTECT_ERROR);
  }
}
