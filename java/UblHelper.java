import net.sf.saxon.s9api.Processor;
import net.sf.saxon.s9api.SaxonApiException;
import net.sf.saxon.s9api.Serializer;
import net.sf.saxon.s9api.XmlProcessingError;
import net.sf.saxon.s9api.Xslt30Transformer;
import net.sf.saxon.s9api.XsltCompiler;
import net.sf.saxon.s9api.XsltExecutable;
import net.sf.saxon.s9api.Location;
import net.sf.saxon.s9api.SaxonApiUncheckedException;
import net.sf.saxon.Configuration;
import net.sf.saxon.trans.XPathException;
import net.sf.saxon.lib.ResourceResolver;
import net.sf.saxon.lib.Feature;
import net.sf.saxon.lib.EnvironmentVariableResolver;
import org.xml.sax.ErrorHandler;
import org.xml.sax.InputSource;
import org.xml.sax.SAXParseException;
import org.xml.sax.XMLReader;

import javax.xml.XMLConstants;
import javax.xml.parsers.SAXParserFactory;
import javax.xml.transform.sax.SAXSource;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import javax.xml.validation.Validator;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Long-lived helper process for the UBL Validator extension.
 *
 * Server mode ("serve") reads one request per line from stdin and writes one
 * response per line to stdout, so the JVM start-up cost and the compilation of
 * the large Schematron stylesheets are paid only once per VS Code session.
 *
 *   request:  id \t command \t arg1 \t arg2 ...
 *   response: id \t ok|err \t base64(output) \t base64(messages)
 *
 * Commands:
 *   transform <xsl> <source> <cache:0|1> [roots]
 *                                          XSLT transform with Saxon-HE. With
 *                                          "roots" (paths joined by the path
 *                                          separator) the stylesheet runs
 *                                          sandboxed: it may only read files
 *                                          below those folders and may not
 *                                          write files (xsl:result-document)
 *   unzip <zip> <destDir>                  extracts an archive (zip-slip safe)
 *   xsd <schema> <document>                XSD validation; messages are
 *                                          "line\tcolumn\tseverity\tmessage" lines
 *   ping                                   returns Java + Saxon versions
 *
 * One-shot mode: "transform <xsl> <source>" or "xsd <schema> <document>"
 * prints the output to stdout and the messages to stderr.
 */
public class UblHelper {
    private final Processor processor = new Processor(false);
    /** Separate processor for downloaded rule stylesheets (see sandboxRoots()) */
    private final Processor sandboxProcessor = createSandboxProcessor();

    private static Processor createSandboxProcessor() {
        Processor p = new Processor(false);
        // Rules must not see environment variables (they may hold credentials)
        p.getUnderlyingConfiguration().setConfigurationProperty(Feature.ENVIRONMENT_VARIABLE_RESOLVER,
                new EnvironmentVariableResolver() {
                    @Override
                    public java.util.Set<String> getAvailableEnvironmentVariables() {
                        return java.util.Collections.emptySet();
                    }

                    @Override
                    public String getEnvironmentVariable(String name) {
                        return null;
                    }
                });
        return p;
    }
    private final Map<String, CachedExecutable> xsltCache = new HashMap<>();
    private final Map<String, Schema> schemaCache = new HashMap<>();

    private static final class CachedExecutable {
        final long lastModified;
        final XsltExecutable executable;

        CachedExecutable(long lastModified, XsltExecutable executable) {
            this.lastModified = lastModified;
            this.executable = executable;
        }
    }

    private static final class Result {
        final String output;
        final String messages;

        Result(String output, String messages) {
            this.output = output;
            this.messages = messages;
        }
    }

    private static final class ToolException extends Exception {
        final String messages;

        ToolException(String message, String messages) {
            super(message);
            this.messages = messages;
        }
    }

    public static void main(String[] args) throws Exception {
        UblHelper helper = new UblHelper();
        if (args.length == 1 && args[0].equals("serve")) {
            helper.serve();
            return;
        }
        if (args.length == 3 && (args[0].equals("transform") || args[0].equals("xsd"))) {
            try {
                Result r = args[0].equals("transform")
                        ? helper.transform(args[1], args[2], false, null)
                        : helper.validateXsd(args[1], args[2]);
                System.out.print(r.output);
                System.err.print(r.messages);
                System.exit(0);
            } catch (ToolException e) {
                System.err.println(e.getMessage());
                System.err.print(e.messages);
                System.exit(1);
            }
        }
        System.err.println("Usage: UblHelper serve | transform <xsl> <source> | xsd <schema> <document>");
        System.exit(2);
    }

    private void serve() throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintWriter out = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), false);
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isEmpty()) {
                continue;
            }
            String[] parts = line.split("\t", -1);
            String id = parts[0];
            String status = "ok";
            String output = "";
            String messages = "";
            try {
                Result r = dispatch(parts);
                output = r.output;
                messages = r.messages;
            } catch (ToolException e) {
                status = "err";
                messages = e.getMessage() + "\n" + e.messages;
            } catch (Throwable t) {
                status = "err";
                messages = t.toString();
            }
            out.print(id + "\t" + status + "\t" + b64(output) + "\t" + b64(messages) + "\n");
            out.flush();
        }
    }

    private Result dispatch(String[] parts) throws Exception {
        String cmd = parts.length > 1 ? parts[1] : "";
        switch (cmd) {
            case "ping":
                return new Result(
                        "java=" + System.getProperty("java.version") + "\nsaxon=" + processor.getSaxonProductVersion(),
                        "");
            case "transform":
                requireArgs(parts, 5);
                return transform(parts[2], parts[3], parts[4].equals("1"),
                        parts.length > 5 && !parts[5].isEmpty() ? sandboxRoots(parts[5]) : null);
            case "unzip":
                requireArgs(parts, 4);
                return unzip(parts[2], parts[3]);
            case "xsd":
                requireArgs(parts, 4);
                return validateXsd(parts[2], parts[3]);
            default:
                throw new ToolException("Unknown command: " + cmd, "");
        }
    }

    private static void requireArgs(String[] parts, int n) throws ToolException {
        if (parts.length < n) {
            throw new ToolException("Malformed request", "");
        }
    }

    // ─── XSLT ──────────────────────────────────────────────────────────

    private Result transform(String xslPath, String sourcePath, boolean cache, List<Path> roots) throws Exception {
        StringBuilder messages = new StringBuilder();
        XsltExecutable executable = compile(xslPath, cache, roots, messages);

        Xslt30Transformer transformer = executable.load30();
        if (roots != null) {
            transformer.setResourceResolver(restrictedResolver(roots));
            transformer.setResultDocumentHandler(uri -> {
                throw new SaxonApiUncheckedException(
                        new SaxonApiException("xsl:result-document is not allowed in validation rules"));
            });
        }
        transformer.setMessageHandler(m ->
                messages.append("message: ").append(m.getContent().getStringValue()).append('\n'));
        transformer.setErrorReporter(e -> appendError(messages, e));

        StringWriter sw = new StringWriter();
        Serializer serializer = transformer.newSerializer(sw);
        try {
            transformer.transform(secureSource(sourcePath), serializer);
        } catch (SaxonApiException e) {
            throw new ToolException(formatSaxonException("Transformation error", e), messages.toString());
        }
        return new Result(sw.toString(), messages.toString());
    }

    private XsltExecutable compile(String xslPath, boolean cache, List<Path> roots, StringBuilder messages) throws ToolException {
        File xsl = new File(xslPath);
        if (roots != null) {
            try {
                allowedFile(xsl.toURI().toString(), null, roots);
            } catch (XPathException e) {
                throw new ToolException("Stylesheet is outside the sandbox: " + xslPath, "");
            }
        }
        String cacheKey = (roots != null ? "sandbox:" : "") + xsl.getAbsolutePath();
        if (cache) {
            CachedExecutable cached = xsltCache.get(cacheKey);
            if (cached != null && cached.lastModified == xsl.lastModified()) {
                return cached.executable;
            }
        }

        XsltCompiler compiler = (roots != null ? sandboxProcessor : processor).newXsltCompiler();
        if (roots != null) {
            compiler.setResourceResolver(restrictedResolver(roots));
        }
        StringBuilder compileErrors = new StringBuilder();
        compiler.setErrorReporter(e -> appendError(e.isWarning() ? messages : compileErrors, e));
        try {
            XsltExecutable executable = compiler.compile(new StreamSource(xsl));
            if (cache) {
                xsltCache.put(cacheKey, new CachedExecutable(xsl.lastModified(), executable));
            }
            return executable;
        } catch (SaxonApiException e) {
            String detail = compileErrors.length() > 0 ? compileErrors.toString() : formatSaxonException("", e) + "\n";
            throw new ToolException("Stylesheet compilation failed", detail + messages);
        }
    }

    private static void appendError(StringBuilder sb, XmlProcessingError e) {
        sb.append(e.isWarning() ? "warning: " : "error: ");
        Location loc = e.getLocation();
        if (loc != null && loc.getSystemId() != null) {
            sb.append(loc.getSystemId());
            if (loc.getLineNumber() > 0) {
                sb.append(':').append(loc.getLineNumber());
            }
            sb.append(": ");
        }
        sb.append(e.getMessage().replace('\n', ' ')).append('\n');
    }

    private static String formatSaxonException(String prefix, SaxonApiException e) {
        StringBuilder sb = new StringBuilder(prefix);
        if (e.getSystemId() != null) {
            sb.append(prefix.isEmpty() ? "" : " at ").append(e.getSystemId());
            if (e.getLineNumber() > 0) {
                sb.append(':').append(e.getLineNumber());
            }
        }
        if (sb.length() > 0) {
            sb.append(": ");
        }
        sb.append(e.getMessage());
        return sb.toString();
    }

    // ─── Sandbox for downloaded rules ──────────────────────────────────

    private List<Path> sandboxRoots(String spec) throws ToolException {
        List<Path> roots = new ArrayList<>();
        for (String p : spec.split(java.util.regex.Pattern.quote(File.pathSeparator))) {
            if (!p.isEmpty()) {
                roots.add(Paths.get(p).toAbsolutePath().normalize());
            }
        }
        if (roots.isEmpty()) {
            throw new ToolException("Empty sandbox root list", "");
        }
        Configuration config = sandboxProcessor.getUnderlyingConfiguration();
        config.setResourceResolver(restrictedResolver(roots));
        config.setUnparsedTextURIResolver((uri, encoding, cfg) -> {
            Path file = allowedFile(uri.toString(), null, roots);
            try {
                return Files.newBufferedReader(file, encoding == null
                        ? StandardCharsets.UTF_8 : java.nio.charset.Charset.forName(encoding));
            } catch (Exception e) {
                throw new XPathException("Cannot read " + uri + ": " + e.getMessage());
            }
        });
        config.setCollectionFinder((context, uri) -> {
            throw new XPathException("collection() is not allowed in validation rules");
        });
        return roots;
    }

    private static ResourceResolver restrictedResolver(List<Path> roots) {
        return request -> {
            Path file = request.uri != null && !request.uri.isEmpty()
                    ? allowedFile(request.uri, null, roots)
                    : allowedFile(request.relativeUri, request.baseUri, roots);
            return new StreamSource(file.toFile());
        };
    }

    /** Resolves href against base and allows it only if it's a file below one of the roots. */
    private static Path allowedFile(String href, String base, List<Path> roots) throws XPathException {
        try {
            URI uri = base != null && !base.isEmpty() ? new URI(base).resolve(href) : new URI(href);
            if (!"file".equals(uri.getScheme())) {
                throw new XPathException("Access denied (only local rule files may be read): " + uri);
            }
            Path path = Paths.get(uri).toAbsolutePath().normalize();
            for (Path root : roots) {
                if (path.startsWith(root)) {
                    return path;
                }
            }
            throw new XPathException("Access denied (outside the rule folder): " + path);
        } catch (java.net.URISyntaxException | IllegalArgumentException e) {
            throw new XPathException("Invalid URI: " + href);
        }
    }

    private static Result unzip(String zipPath, String destDir) throws Exception {
        Path dest = Paths.get(destDir).toAbsolutePath().normalize();
        Files.createDirectories(dest);
        int count = 0;
        long total = 0;
        final int maxEntries = 50_000;
        final long maxBytes = 1024L * 1024 * 1024;
        byte[] buf = new byte[64 * 1024];
        try (ZipInputStream zin = new ZipInputStream(Files.newInputStream(Paths.get(zipPath)))) {
            ZipEntry entry;
            while ((entry = zin.getNextEntry()) != null) {
                Path target = dest.resolve(entry.getName()).normalize();
                if (!target.startsWith(dest)) {
                    throw new ToolException("Archive entry outside target folder: " + entry.getName(), "");
                }
                if (entry.isDirectory()) {
                    Files.createDirectories(target);
                } else {
                    if (++count > maxEntries) {
                        throw new ToolException("Archive has too many entries", "");
                    }
                    Files.createDirectories(target.getParent());
                    try (java.io.OutputStream os = Files.newOutputStream(target)) {
                        int n;
                        while ((n = zin.read(buf)) > 0) {
                            total += n;
                            if (total > maxBytes) {
                                throw new ToolException("Archive expands to more than 1 GB", "");
                            }
                            os.write(buf, 0, n);
                        }
                    }
                }
            }
        }
        return new Result(String.valueOf(count), "");
    }

    // ─── XSD ───────────────────────────────────────────────────────────

    private Result validateXsd(String schemaPath, String documentPath) throws Exception {
        Schema schema = loadSchema(schemaPath);
        Validator validator = schema.newValidator();
        // Never fetch schemas or DTDs referenced from the instance document
        validator.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        validator.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");

        final List<String> issues = new ArrayList<>();
        validator.setErrorHandler(new ErrorHandler() {
            @Override
            public void warning(SAXParseException e) {
                issues.add(formatIssue("warning", e));
            }

            @Override
            public void error(SAXParseException e) {
                issues.add(formatIssue("error", e));
            }

            @Override
            public void fatalError(SAXParseException e) {
                issues.add(formatIssue("error", e));
            }
        });

        try {
            validator.validate(secureSource(documentPath));
        } catch (SAXParseException e) {
            // Fatal (well-formedness) errors are already reported via the handler
        }
        return new Result("", String.join("\n", issues));
    }

    private Schema loadSchema(String schemaPath) throws Exception {
        File file = new File(schemaPath);
        Schema schema = schemaCache.get(file.getAbsolutePath());
        if (schema != null) {
            return schema;
        }
        SchemaFactory factory = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        // UBL schemas import each other via relative file paths
        factory.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "file");
        schema = factory.newSchema(file);
        schemaCache.put(file.getAbsolutePath(), schema);
        return schema;
    }

    private static String formatIssue(String severity, SAXParseException e) {
        String msg = e.getMessage() == null ? "" : e.getMessage().replace('\n', ' ').replace('\t', ' ');
        return e.getLineNumber() + "\t" + e.getColumnNumber() + "\t" + severity + "\t" + msg;
    }

    // ─── Shared ────────────────────────────────────────────────────────

    /**
     * Parser for documents under validation: no external entities or DTDs,
     * so a hostile invoice cannot read local files (XXE).
     */
    private static SAXSource secureSource(String path) throws Exception {
        SAXParserFactory spf = SAXParserFactory.newInstance();
        spf.setNamespaceAware(true);
        spf.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        spf.setFeature("http://xml.org/sax/features/external-general-entities", false);
        spf.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        spf.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        XMLReader reader = spf.newSAXParser().getXMLReader();
        return new SAXSource(reader, new InputSource(new File(path).toURI().toString()));
    }

    private static String b64(String s) {
        return Base64.getEncoder().encodeToString(s.getBytes(StandardCharsets.UTF_8));
    }
}
