package net.deepseek.chat;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONException;
import org.json.JSONObject;

/** Private on-device preferences only; snapshots leave the app solely through explicit getDiagnostics RPC. */
final class NativeDiagnostics {
    private final SharedPreferences preferences;
    private final DiagnosticBuffer buffer;

    NativeDiagnostics(Context context) {
        this(context.getSharedPreferences("native_diagnostics", Context.MODE_PRIVATE));
    }

    NativeDiagnostics(SharedPreferences preferences) {
        this.preferences = preferences;
        java.util.Map<String, ?> stored = preferences.getAll();
        Object enabled = stored.get("enabled");
        Object events = stored.get("events");
        buffer = new DiagnosticBuffer(!(enabled instanceof Boolean) || (Boolean) enabled,
                events instanceof String ? (String) events : "[]");
        persist(); // Drop any invalid or legacy fields on load as well as on export.
    }

    synchronized void record(DiagnosticBuffer.Event event, Object... fields) {
        if (!buffer.enabled()) return;
        try {
            JSONObject details = new JSONObject();
            for (int i = 0; i + 1 < fields.length; i += 2) {
                if (fields[i] instanceof String) details.put((String) fields[i], fields[i + 1]);
            }
            buffer.record(event, System.currentTimeMillis(), details);
            persist();
        } catch (JSONException ignored) { /* Diagnostic recording must not interrupt permission handling. */ }
    }

    synchronized void setEnabled(boolean enabled) { buffer.setEnabled(enabled); persist(); }
    synchronized void clear() { buffer.clear(); persist(); }
    private void persist() {
        preferences.edit().clear().putBoolean("enabled", buffer.enabled()).putString("events", buffer.serialized()).apply();
    }

    synchronized JSONObject snapshot(String versionName, int versionCode, int androidSdk,
            String webViewVersion, boolean microphoneGranted, boolean audioSettingsGranted) throws JSONException {
        return new JSONObject().put("versionName", versionName).put("versionCode", versionCode)
                .put("androidSdk", androidSdk).put("webViewVersion", DiagnosticBuffer.safeWebViewVersion(webViewVersion))
                .put("microphoneGranted", microphoneGranted).put("audioSettingsGranted", audioSettingsGranted)
                .put("enabled", buffer.enabled())
                .put("events", buffer.snapshot());
    }
}
