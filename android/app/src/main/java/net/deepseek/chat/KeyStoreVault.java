package net.deepseek.chat;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Never persists the API key in clear text, and never falls back after Keystore failure. */
final class KeyStoreVault {
    private static final String ALIAS = "deepseek.api-key.v1";
    private final SharedPreferences prefs;
    KeyStoreVault(Context context) {
        prefs = context.getSharedPreferences("encrypted_credentials", Context.MODE_PRIVATE);
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        }
        if (!create) throw new IllegalStateException("Keystore key is missing; clear the saved key and enter it again");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    String get() throws Exception {
        String encoded = prefs.getString("sealed", null);
        if (encoded == null) return null;
        String[] parts = encoded.split(":", -1);
        if (parts.length != 2) throw new IllegalStateException("Encrypted key data is invalid");
        byte[] iv = Base64.getDecoder().decode(parts[0]);
        if (iv.length != 12) throw new IllegalStateException("Encrypted key IV is invalid");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(Base64.getDecoder().decode(parts[1])), StandardCharsets.UTF_8);
    }

    void set(String value) throws Exception {
        if (value == null) {
            if (!prefs.edit().remove("sealed").commit()) throw new IllegalStateException("Could not clear saved key");
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS);
            return;
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        String encoded = Base64.getEncoder().encodeToString(cipher.getIV()) + ":"
                + Base64.getEncoder().encodeToString(encrypted);
        if (!prefs.edit().putString("sealed", encoded).commit()) {
            throw new IllegalStateException("Could not persist encrypted key");
        }
    }
}
