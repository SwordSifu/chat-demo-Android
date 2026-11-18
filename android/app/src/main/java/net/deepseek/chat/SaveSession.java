package net.deepseek.chat;

import android.content.ContentResolver;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.IOException;
import java.io.OutputStream;

/** Accessed only on the bridge's single IO executor. No complete export is held in RAM. */
final class SaveSession {
    final Uri uri;
    private final ContentResolver resolver;
    private OutputStream stream;

    SaveSession(ContentResolver resolver, Uri uri) throws IOException {
        this.uri = uri;
        this.resolver = resolver;
        stream = resolver.openOutputStream(uri, "wt");
        if (stream == null) throw new IOException("Document provider did not open an output stream");
    }

    void append(byte[] bytes) throws IOException {
        if (stream == null) throw new IOException("Save is closed");
        stream.write(bytes);
    }

    void finish() throws IOException {
        if (stream == null) throw new IOException("Save is closed");
        OutputStream current = stream;
        stream = null;
        try { current.flush(); } finally { current.close(); }
    }

    void cancel() {
        if (stream != null) {
            try { stream.close(); } catch (IOException ignored) { }
            stream = null;
        }
        // Providers can reject deletion. A cancelled export is never reported as success;
        // the user may need to remove a partial document from such a provider manually.
        try { DocumentsContract.deleteDocument(resolver, uri); } catch (Exception ignored) { }
    }
}
