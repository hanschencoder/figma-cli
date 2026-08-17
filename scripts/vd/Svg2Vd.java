// SVG → VectorDrawable，调 Android Studio 内部那份 Svg2Vector。
// 由 build-deps-jar.sh 编译进 skills/figma-cli/scripts/lib/svg2vd-deps.jar（--release 11），
// 运行期只需要 JRE 11+。
//
// 用法：Svg2Vd <outDir> <in.svg> <outName> [<in.svg> <outName> ...]
//
// stdout 每个文件一行，制表符分隔：
//   ok    <outName>  <path 数>
//   fail  <in.svg>   <原因>          ← 调用方据此走 PNG 回退
// 详细的 Svg2Vector 日志走 stderr。
//
// 失败判定不只看异常。Svg2Vector 遇到 <filter> / <mask> / <pattern> 这类
// VectorDrawable 表达不了的东西时，会把 "ERROR @ line N: ..." 放进返回值，
// 但**照样吐出一个看起来合法的 XML** —— 里面可能留着 android:fillColor="url(#p)"
// 这种构建期才炸的值，也可能只是默默丢掉了效果。这种产物不能要。
import com.android.ide.common.vectordrawable.Svg2Vector;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.OutputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.regex.Pattern;

public class Svg2Vd {
    /** 颜色属性里残留的 url(#id) —— VectorDrawable 不认，aapt 会报错。 */
    private static final Pattern UNRESOLVED_REF =
            Pattern.compile("android:(fill|stroke)Color=\"url\\(");

    // sdk-common 31.x 是 parseSvgToXml(Path, OutputStream)，30.x 及更早是 (File, OutputStream)。
    // 内置 jar 是固定版本，但 $FIGMA_VD_CP 允许指向别的 jar，所以反射派发留着。
    private static final Method PARSE;
    private static final boolean TAKES_PATH;
    static {
        Method m;
        boolean path = true;
        try {
            m = Svg2Vector.class.getMethod("parseSvgToXml", Path.class, OutputStream.class);
        } catch (NoSuchMethodException e) {
            try {
                m = Svg2Vector.class.getMethod("parseSvgToXml", File.class, OutputStream.class);
                path = false;
            } catch (NoSuchMethodException e2) {
                throw new ExceptionInInitializerError(
                        "Svg2Vector 没有可用的 parseSvgToXml —— sdk-common 版本不对");
            }
        }
        PARSE = m;
        TAKES_PATH = path;
    }

    private static String parse(Path in, OutputStream out) throws Exception {
        try {
            return (String) PARSE.invoke(null, TAKES_PATH ? in : in.toFile(), out);
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause();
            throw cause instanceof Exception ? (Exception) cause : new RuntimeException(cause);
        }
    }

    public static void main(String[] args) throws Exception {
        Path outDir = Paths.get(args[0]);
        Files.createDirectories(outDir);
        int failed = 0;

        for (int i = 1; i + 1 < args.length; i += 2) {
            Path in = Paths.get(args[i]);
            String outName = args[i + 1];

            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            String log;
            try {
                log = parse(in, buf);
            } catch (Exception e) {
                fail(in, "Svg2Vector 抛异常：" + e);
                failed++;
                continue;
            }

            String xml = buf.toString(StandardCharsets.UTF_8.name());
            String reason = verdict(xml, log);
            if (reason != null) {
                if (log != null && !log.trim().isEmpty()) {
                    for (String line : log.split("\\R")) {
                        if (!line.trim().isEmpty()) System.err.println("log\t" + in + "\t" + line.trim());
                    }
                }
                fail(in, reason);
                failed++;
                continue;
            }

            Files.write(outDir.resolve(outName), xml.getBytes(StandardCharsets.UTF_8));
            System.out.println("ok\t" + outName + "\t" + countPaths(xml));
        }
        if (failed > 0) System.exit(2);
    }

    /** 返回失败原因；null 表示这份产物可以用。 */
    private static String verdict(String xml, String log) {
        if (xml == null || xml.trim().isEmpty()) return "转换结果为空（SVG 可能损坏或不是有效的 SVG）";
        if (log != null && log.contains("ERROR")) {
            String first = "";
            for (String line : log.split("\\R")) {
                if (line.contains("ERROR")) { first = line.trim(); break; }
            }
            return "VectorDrawable 表达不了：" + first;
        }
        if (UNRESOLVED_REF.matcher(xml).find()) {
            return "产物里残留 url(#...) 引用，aapt 会报错";
        }
        if (!xml.contains("<path")) return "产物里一条 path 都没有";
        return null;
    }

    private static void fail(Path in, String reason) {
        System.out.println("fail\t" + in + "\t" + reason);
    }

    private static int countPaths(String xml) {
        int n = 0, at = 0;
        while ((at = xml.indexOf("<path", at)) >= 0) { n++; at += 5; }
        return n;
    }
}
