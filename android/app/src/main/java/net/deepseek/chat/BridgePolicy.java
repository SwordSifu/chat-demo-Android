package net.deepseek.chat;

import java.net.URI;
import java.util.Base64;

/** Pure Java protocol validation: also exercised by host JVM tests. */
final class BridgePolicy {
    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final String HOME = ORIGIN + "/assets/index.html";
    static final int MAX_CHUNK_BYTES = 64 * 1024;
    static final int MAX_MESSAGE_CHARS = 128 * 1024;
    private BridgePolicy() {}

    static boolean trustedOrigin(String raw) {
        try {
            URI u = URI.create(raw);
            return "https".equalsIgnoreCase(u.getScheme())
                    && "appassets.androidplatform.net".equalsIgnoreCase(u.getHost())
                    && (u.getPort() == -1 || u.getPort() == 443)
                    && u.getRawUserInfo() == null;
        } catch (RuntimeException e) { return false; }
    }

    static boolean trustedPage(String raw) {
        if (!trustedOrigin(raw)) return false;
        try { return URI.create(raw).getPath().startsWith("/assets/"); }
        catch (RuntimeException e) { return false; }
    }

    static boolean allowedApi(String raw) {
        try {
            URI u = URI.create(raw);
            return "https".equalsIgnoreCase(u.getScheme())
                    && "api.deepseek.com".equalsIgnoreCase(u.getHost())
                    && (u.getPort() == -1 || u.getPort() == 443)
                    && u.getRawUserInfo() == null;
        } catch (RuntimeException e) { return false; }
    }

    static boolean externalUrl(String raw) {
        try {
            URI uri = URI.create(raw);
            return ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))
                    && uri.getHost() != null && uri.getRawUserInfo() == null;
        } catch (RuntimeException e) { return false; }
    }

    static byte[] decodeChunk(String data) {
        if (data.length() > ((MAX_CHUNK_BYTES + 2) / 3) * 4) {
            throw new IllegalArgumentException("Chunk exceeds 64 KiB decoded limit");
        }
        byte[] bytes = Base64.getDecoder().decode(data);
        if (bytes.length > MAX_CHUNK_BYTES) {
            throw new IllegalArgumentException("Chunk exceeds 64 KiB decoded limit");
        }
        return bytes;
    }

    static String mimeType(String raw) {
        String mime = raw.split(";", 2)[0].trim().toLowerCase(java.util.Locale.ROOT);
        if (!mime.matches("[\\w.+-]+/[\\w.+-]+")) throw new IllegalArgumentException("Invalid MIME type");
        return mime;
    }

    static String safeName(String raw) {
        String name = raw.replaceAll("[\\\\/\\p{Cntrl}]", "_").trim();
        if (name.isEmpty()) name = "export";
        return name.substring(0, Math.min(name.length(), 180));
    }
}
