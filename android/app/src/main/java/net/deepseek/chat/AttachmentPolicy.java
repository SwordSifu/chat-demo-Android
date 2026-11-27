package net.deepseek.chat;

import java.io.IOException;
import java.io.InputStream;
import java.util.BitSet;
import java.util.regex.Pattern;

/** The web chooser markers and capture ownership rules, independent of Android APIs. */
final class AttachmentPolicy {
    enum Kind { DOCUMENT, GALLERY, CAMERA }

    static final long DELIVERY_LEASE_MS = 60_000;
    static final long MAX_CAPTURE_BYTES = 32L * 1024 * 1024;
    private static final long MAX_CAPTURE_PIXELS = 110_000_000L;
    private static final Pattern CAPTURE_NAME = Pattern.compile("chatdemo-capture-[0-9a-f]{32}\\.jpg");
    private static final Pattern CAMERA_OUTPUT_NAME = Pattern.compile("chatdemo-camera-output-[0-9a-f]{32}\\.jpg");
    private static final Pattern IMAGE_MIME = Pattern.compile("image/[a-z0-9.+_-]+", Pattern.CASE_INSENSITIVE);

    private AttachmentPolicy() { }

    static Kind chooserKind(String[] accept, boolean capture, boolean multiple) {
        if (accept == null || accept.length != 1) return Kind.DOCUMENT;
        if (capture && !multiple && "image/jpeg".equalsIgnoreCase(accept[0])) return Kind.CAMERA;
        if (!capture && "image/*".equalsIgnoreCase(accept[0])) return Kind.GALLERY;
        return Kind.DOCUMENT;
    }

    static boolean captureName(String name) {
        return name != null && CAPTURE_NAME.matcher(name).matches();
    }

    static boolean cameraOutputName(String name) {
        return name != null && CAMERA_OUTPUT_NAME.matcher(name).matches();
    }

    static boolean imageMime(String type) {
        return type != null && IMAGE_MIME.matcher(type).matches();
    }

    static boolean validJpeg(long bytes, String type, int width, int height) {
        return bytes >= 4 && bytes <= MAX_CAPTURE_BYTES && "image/jpeg".equals(type) && width > 0 && height > 0
                && (long) width * height <= MAX_CAPTURE_PIXELS;
    }

    /** Find the primary JPEG EOI, ignoring markers embedded in metadata and any trailing payload. */
    static long primaryJpegEnd(InputStream input) throws IOException {
        if (input.read() != 0xFF || input.read() != 0xD8) return -1;
        long position = 2;
        boolean inScan = false, sawScan = false;
        while (position < MAX_CAPTURE_BYTES) {
            int value = input.read();
            if (value < 0) return -1;
            position++;
            if (value != 0xFF) {
                if (!inScan) return -1;
                continue;
            }
            int marker;
            do {
                marker = input.read();
                if (marker < 0 || ++position > MAX_CAPTURE_BYTES) return -1;
            } while (marker == 0xFF);
            if (marker == 0 || (marker >= 0xD0 && marker <= 0xD7)) {
                if (!inScan) return -1; // byte stuffing and restart markers occur inside a scan
                continue;
            }
            if (marker == 0xD9) return sawScan ? position : -1;
            if (marker == 0xD8) return -1;
            if (marker == 0x01) continue; // standalone temporary marker
            int high = input.read(), low = input.read();
            if (high < 0 || low < 0) return -1;
            int length = (high << 8) | low;
            if (length < 2 || position + length > MAX_CAPTURE_BYTES) return -1;
            for (long remaining = length - 2; remaining > 0; ) {
                long skipped = input.skip(remaining);
                if (skipped == 0) {
                    if (input.read() < 0) return -1;
                    skipped = 1;
                }
                remaining -= skipped;
            }
            position += length;
            inScan = marker == 0xDA;
            sawScan |= inScan;
        }
        return -1;
    }

    static final class Lease {
        private final long deliveredAt;
        private boolean retained;

        Lease(long deliveredAt) { this.deliveredAt = deliveredAt; }

        boolean expired(long now) { return !retained && now - deliveredAt >= DELIVERY_LEASE_MS; }

        boolean retain(long now) {
            if (expired(now)) return false;
            retained = true;
            return true;
        }
    }

    /** Outstanding chooser codes survive recreation, but their WebView callbacks do not. */
    static final class RequestCodes {
        // Do not overlap CREATE_FILE (2002) or microphone permissions (4096+).
        private static final int FIRST = 2048, COUNT = 2048;
        private final BitSet outstanding = new BitSet(COUNT);

        RequestCodes(int[] previous) {
            if (previous != null) {
                for (int code : previous) if (valid(code)) outstanding.set(code - FIRST);
            }
        }

        int start() {
            int index = outstanding.nextClearBit(0);
            if (index >= COUNT) throw new IllegalStateException("Too many pending file choosers");
            outstanding.set(index);
            return FIRST + index;
        }

        boolean finish(int code) {
            if (!valid(code) || !outstanding.get(code - FIRST)) return false;
            outstanding.clear(code - FIRST);
            return true;
        }

        int[] snapshot() { return outstanding.stream().map(i -> i + FIRST).toArray(); }

        private static boolean valid(int code) { return code >= FIRST && code < FIRST + COUNT; }
    }
}
