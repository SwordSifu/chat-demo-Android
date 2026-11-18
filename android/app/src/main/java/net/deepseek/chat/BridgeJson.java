package net.deepseek.chat;

import org.json.JSONException;
import org.json.JSONObject;

/** JSON envelope shared by the listener and JVM protocol tests. */
final class BridgeJson {
    private BridgeJson() {}
    static String string(JSONObject object, String name) throws JSONException {
        Object value = object.get(name);
        if (!(value instanceof String)) throw new JSONException(name + " must be a string");
        return (String) value;
    }
    static String response(String id, Object value, String code, String message) throws JSONException {
        JSONObject reply = new JSONObject().put("id", id).put("ok", code == null);
        if (code == null) reply.put("value", value == null ? JSONObject.NULL : value);
        else reply.put("error", new JSONObject().put("code", code)
                .put("message", message == null || message.isEmpty() ? "Native operation failed" : message));
        return reply.toString();
    }
}
