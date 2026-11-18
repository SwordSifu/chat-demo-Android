package net.deepseek.chat;

import android.content.SharedPreferences;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class NativeDiagnosticsTest {
    @Test public void defaultsEnabledAndSnapshotHasOnlyContractEnvironmentFields() throws Exception {
        MemoryPreferences prefs = new MemoryPreferences();
        NativeDiagnostics store = new NativeDiagnostics(prefs);
        JSONObject snapshot = store.snapshot("1.0.4", 5, 35, "132.0.1.2", false, false);
        assertEquals(8, snapshot.length());
        assertFalse(snapshot.getBoolean("audioSettingsGranted"));
        assertTrue(snapshot.getBoolean("enabled"));
        assertFalse(snapshot.getBoolean("microphoneGranted"));
        assertEquals("1.0.4", snapshot.getString("versionName"));
        assertEquals(5, snapshot.getInt("versionCode"));
        assertEquals(35, snapshot.getInt("androidSdk"));
        assertEquals("132.0.1.2", snapshot.getString("webViewVersion"));
        assertEquals(0, snapshot.getJSONArray("events").length());
        assertTrue(prefs.getBoolean("enabled", false));
    }
    @Test public void disablingPersistsAndNoLaterEventsAreAddedAcrossReload() throws Exception {
        MemoryPreferences prefs = new MemoryPreferences();
        NativeDiagnostics store = new NativeDiagnostics(prefs);
        store.record(DiagnosticBuffer.Event.START, "androidSdk", 35);
        store.setEnabled(false);
        store.record(DiagnosticBuffer.Event.PAUSE, "pending", true);
        NativeDiagnostics restored = new NativeDiagnostics(prefs);
        restored.record(DiagnosticBuffer.Event.RESUME);
        JSONObject snapshot = restored.snapshot("1", 1, 35, "132", true, true);
        assertFalse(snapshot.getBoolean("enabled"));
        assertEquals(1, snapshot.getJSONArray("events").length());
    }
    @Test public void clearingPersistsAndDoesNotChangeEnablePreference() throws Exception {
        MemoryPreferences prefs = new MemoryPreferences();
        NativeDiagnostics store = new NativeDiagnostics(prefs);
        store.record(DiagnosticBuffer.Event.START);
        store.setEnabled(false);
        store.clear();
        JSONObject snapshot = new NativeDiagnostics(prefs).snapshot("1", 1, 26, null, false, false);
        assertFalse(snapshot.getBoolean("enabled"));
        assertEquals(0, snapshot.getJSONArray("events").length());
        assertEquals("unknown", snapshot.getString("webViewVersion"));
    }
    @Test public void malformedPreferenceTypesAndUnknownRootFieldsAreReplaced() throws Exception {
        MemoryPreferences prefs = new MemoryPreferences();
        prefs.values.put("enabled", "private token");
        prefs.values.put("events", true);
        prefs.values.put("privateKey", "sk-private");
        JSONObject snapshot = new NativeDiagnostics(prefs).snapshot("1", 1, 35, "132", false, false);
        assertTrue(snapshot.getBoolean("enabled"));
        assertEquals(0, snapshot.getJSONArray("events").length());
        assertEquals(2, prefs.values.size());
        assertFalse(prefs.values.toString().contains("private"));
    }
    @Test public void persistedEventsStayBoundedAndNeverContainArbitraryFields() throws Exception {
        MemoryPreferences prefs = new MemoryPreferences();
        NativeDiagnostics store = new NativeDiagnostics(prefs);
        for (int i = 0; i < 140; i++) {
            store.record(DiagnosticBuffer.Event.BRIDGE_ERROR, "count", i,
                    "message", "sk-private transcript https://secret/", "errorName", "IOException");
        }
        JSONObject snapshot = new NativeDiagnostics(prefs).snapshot("1", 1, 35, "132", true, true);
        assertEquals(128, snapshot.getJSONArray("events").length());
        assertFalse(prefs.getString("events", "").contains("private"));
        assertTrue(prefs.getString("events", "").length() <= DiagnosticBuffer.MAX_BYTES);
    }

    @Test public void realSnapshotWireNamesExactlyMatchFrontendContract() throws Exception {
        String[] expected = {"native.start", "native.permission.request", "native.permission.result", "native.permission.cancel",
                "native.lifecycle.pause", "native.lifecycle.stop", "native.lifecycle.resume", "native.renderer.gone", "native.bridge.error"};
        MemoryPreferences prefs = new MemoryPreferences();
        NativeDiagnostics store = new NativeDiagnostics(prefs);
        for (DiagnosticBuffer.Event event : DiagnosticBuffer.Event.values()) store.record(event);
        org.json.JSONArray events = store.snapshot("test", 1, 35, "132", false, false).getJSONArray("events");
        assertEquals(expected.length, events.length());
        for (int i = 0; i < expected.length; i++) assertEquals(expected[i], events.getJSONObject(i).getString("event"));
        org.json.JSONArray reloaded = new NativeDiagnostics(prefs).snapshot("test", 1, 35, "132", false, false).getJSONArray("events");
        for (int i = 0; i < expected.length; i++) assertEquals(expected[i], reloaded.getJSONObject(i).getString("event"));
    }
    @Test public void realSnapshotStatusSurvivesPersistenceAsNonnegativeEnum() throws Exception {
        MemoryPreferences prefs = new MemoryPreferences();
        NativeDiagnostics store = new NativeDiagnostics(prefs);
        for (int value = 0; value <= 4; value++) store.record(DiagnosticBuffer.Event.PERMISSION_RESULT, "status", value);
        org.json.JSONArray events = new NativeDiagnostics(prefs).snapshot("test", 1, 35, "132", false, false).getJSONArray("events");
        for (int i = 0; i <= 4; i++) {
            assertEquals("native.permission.result", events.getJSONObject(i).getString("event"));
            assertEquals(i, events.getJSONObject(i).getJSONObject("details").getInt("status"));
        }
    }

    @Test public void microphoneAndAudioRoutingPermissionsAreIndependentSnapshotFields() throws Exception {
        NativeDiagnostics store = new NativeDiagnostics(new MemoryPreferences());
        JSONObject missingRoute = store.snapshot("1.0.4", 5, 36, "156", true, false);
        assertTrue(missingRoute.getBoolean("microphoneGranted"));
        assertFalse(missingRoute.getBoolean("audioSettingsGranted"));
        JSONObject ready = store.snapshot("1.0.4", 5, 36, "156", true, true);
        assertTrue(ready.getBoolean("audioSettingsGranted"));
    }

    /** SharedPreferences contract fake only; this does not claim Android disk/device testing. */
    private static final class MemoryPreferences implements SharedPreferences {
        final Map<String, Object> values = new HashMap<>();
        @Override public Map<String, ?> getAll() { return new HashMap<>(values); }
        @Override public String getString(String key, String fallback) { return (String) values.getOrDefault(key, fallback); }
        @SuppressWarnings("unchecked")
        @Override public Set<String> getStringSet(String key, Set<String> fallback) {
            return (Set<String>) values.getOrDefault(key, fallback);
        }
        @Override public int getInt(String key, int fallback) { return (Integer) values.getOrDefault(key, fallback); }
        @Override public long getLong(String key, long fallback) { return (Long) values.getOrDefault(key, fallback); }
        @Override public float getFloat(String key, float fallback) { return (Float) values.getOrDefault(key, fallback); }
        @Override public boolean getBoolean(String key, boolean fallback) { return (Boolean) values.getOrDefault(key, fallback); }
        @Override public boolean contains(String key) { return values.containsKey(key); }
        @Override public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) { }
        @Override public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) { }
        @Override public Editor edit() {
            return new Editor() {
                final Map<String, Object> changed = new HashMap<>();
                final Set<String> removed = new HashSet<>();
                boolean cleared;
                @Override public Editor putString(String key, String value) { changed.put(key, value); return this; }
                @Override public Editor putStringSet(String key, Set<String> value) { changed.put(key, value); return this; }
                @Override public Editor putInt(String key, int value) { changed.put(key, value); return this; }
                @Override public Editor putLong(String key, long value) { changed.put(key, value); return this; }
                @Override public Editor putFloat(String key, float value) { changed.put(key, value); return this; }
                @Override public Editor putBoolean(String key, boolean value) { changed.put(key, value); return this; }
                @Override public Editor remove(String key) { removed.add(key); return this; }
                @Override public Editor clear() { cleared = true; return this; }
                @Override public boolean commit() { apply(); return true; }
                @Override public void apply() {
                    if (cleared) values.clear();
                    for (String key : removed) values.remove(key);
                    values.putAll(changed);
                }
            };
        }
    }
}
