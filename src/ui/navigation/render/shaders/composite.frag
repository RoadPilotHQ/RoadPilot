#version 300 es
// PROTOTYPE (M3): lays the per-class coverage of roadCoverage.frag over each other in draw
// order (rail, minor, local, primary, motorway), each class in its colour, as Canvas 2D strokes
// one class after the other. Output is premultiplied alpha over a transparent canvas.
precision highp float;
precision highp int;

uniform sampler2D u_low;    // slots 0-3
uniform sampler2D u_high;   // slot 4 in r
uniform vec3 u_colors[5];   // per draw-order slot

out vec4 outColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 lo = texelFetch(u_low, p, 0);
  float hi = texelFetch(u_high, p, 0).r;
  float cov[5] = float[5](lo.r, lo.g, lo.b, lo.a, hi);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 5; i++) {
    float a = cov[i];
    acc = vec4(u_colors[i] * a, a) + acc * (1.0 - a);
  }
  outColor = acc;
}
