float getSdfRectangle(in vec2 p, in vec2 xy, in vec2 b)
{
    vec2 d = abs(p - xy) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// Based on Inigo Quilez's 2D distance functions article: https://iquilezles.org/articles/distfunctions2d/
float seg(in vec2 p, in vec2 a, in vec2 b, inout float s, float d) {
    vec2 e = b - a;
    vec2 w = p - a;
    vec2 proj = a + e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    float segd = dot(p - proj, p - proj);
    d = min(d, segd);

    float c0 = step(0.0, p.y - a.y);
    float c1 = 1.0 - step(0.0, p.y - b.y);
    float c2 = 1.0 - step(0.0, e.x * w.y - e.y * w.x);
    float allCond = c0 * c1 * c2;
    float noneCond = (1.0 - c0) * (1.0 - c1) * (1.0 - c2);
    float flip = mix(1.0, -1.0, step(0.5, allCond + noneCond));
    s *= flip;
    return d;
}

float getSdfParallelogram(in vec2 p, in vec2 v0, in vec2 v1, in vec2 v2, in vec2 v3) {
    float s = 1.0;
    float d = dot(p - v0, p - v0);

    d = seg(p, v0, v3, s, d);
    d = seg(p, v1, v0, s, d);
    d = seg(p, v2, v1, s, d);
    d = seg(p, v3, v2, s, d);

    return s * sqrt(d);
}

vec2 normalize(vec2 value, float isPosition) {
    return (value * 2.0 - (iResolution.xy * isPosition)) / iResolution.y;
}

float antialias(float distance) {
    return 1.0 - smoothstep(0.0, normalize(vec2(2.2, 2.2), 0.0).x, distance);
}

float determineStartVertexFactor(vec2 a, vec2 b) {
    float condition1 = step(b.x, a.x) * step(a.y, b.y);
    float condition2 = step(a.x, b.x) * step(b.y, a.y);
    return 1.0 - max(condition1, condition2);
}

vec2 getRectangleCenter(vec4 rectangle) {
    return vec2(rectangle.x + (rectangle.z / 2.0), rectangle.y - (rectangle.w / 2.0));
}

float fadeOut(float x) {
    return pow(1.0 - x, 1.35);
}

// Tuned to feel closer to sphamba/smear-cursor.nvim while staying shader-only.
// Ghostty fragment shaders are stateless, so this approximates the spring trail
// with a short, cursor-colored, catch-up fade between previous and current cells.
const float DURATION = 0.30;
const float OPACITY = 0.88;
const float GRADIENT_EXPONENT = 1.15;

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    #if !defined(WEB)
    fragColor = texture(iChannel0, fragCoord.xy / iResolution.xy);
    #endif

    vec4 baseColor = fragColor;
    vec2 vu = normalize(fragCoord, 1.0);
    vec2 offsetFactor = vec2(-0.5, 0.5);

    vec4 currentCursor = vec4(normalize(iCurrentCursor.xy, 1.0), normalize(iCurrentCursor.zw, 0.0));
    vec4 previousCursor = vec4(normalize(iPreviousCursor.xy, 1.0), normalize(iPreviousCursor.zw, 0.0));

    vec2 centerCC = getRectangleCenter(currentCursor);
    vec2 centerCP = getRectangleCenter(previousCursor);
    vec2 movement = centerCC - centerCP;
    float lineLength = distance(centerCC, centerCP);
    float safeLineLength = max(lineLength, 0.0001);
    vec2 direction = movement / safeLineLength;

    float vertexFactor = determineStartVertexFactor(currentCursor.xy, previousCursor.xy);
    float invertedVertexFactor = 1.0 - vertexFactor;

    vec2 v0 = vec2(currentCursor.x + currentCursor.z * vertexFactor, currentCursor.y - currentCursor.w);
    vec2 v1 = vec2(currentCursor.x + currentCursor.z * invertedVertexFactor, currentCursor.y);
    vec2 v2 = vec2(previousCursor.x + currentCursor.z * invertedVertexFactor, previousCursor.y);
    vec2 v3 = vec2(previousCursor.x + currentCursor.z * vertexFactor, previousCursor.y - previousCursor.w);

    float sdfCurrentCursor = getSdfRectangle(vu, currentCursor.xy - (currentCursor.zw * offsetFactor), currentCursor.zw * 0.5);
    float sdfTrail = getSdfParallelogram(vu, v0, v1, v2, v3);

    float progress = clamp((iTime - iTimeCursorChange) / DURATION, 0.0, 1.0);
    float timeFade = fadeOut(progress);

    // 0.0 at previous cursor, 1.0 at current cursor.
    float alongTrail = clamp(dot(vu - centerCP, direction) / safeLineLength, 0.0, 1.0);

    // Let the previous end disappear first, imitating a trailing cursor catching up.
    float catchUpMask = smoothstep(progress - 0.10, progress + 0.18, alongTrail);
    float gradientMask = pow(alongTrail, GRADIENT_EXPONENT);
    float movementMask = smoothstep(0.0, max(currentCursor.z, currentCursor.w) * 0.25, lineLength);

    vec4 smearColor = vec4(iCurrentCursorColor.rgb, 1.0);
    float trailAlpha = antialias(sdfTrail) * gradientMask * catchUpMask * timeFade * movementMask * OPACITY;

    vec4 newColor = mix(baseColor, smearColor, trailAlpha);

    // Very small target-cell halo: keeps the trail visually connected without
    // repainting the real terminal cursor.
    float cursorHalo = (1.0 - smoothstep(0.0, normalize(vec2(3.0, 3.0), 0.0).x, sdfCurrentCursor + 0.002));
    newColor = mix(newColor, smearColor, cursorHalo * timeFade * movementMask * 0.26);

    // Preserve Ghostty's actual cursor pixels at the target cell.
    newColor = mix(newColor, baseColor, step(sdfCurrentCursor, 0.0));

    fragColor = newColor;
}
