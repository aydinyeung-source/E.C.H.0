// reveal.js
// -----------------------------------------------------------------------------
// The sonar-reveal effect, with glow-in-the-dark persistence.
//
// The world is otherwise unlit (pitch black). A pool of sonar WAVEFRONTS sweeps
// outward from where you click; when a front reaches a surface it lights to full,
// then that surface slowly FADES back to black over ~15s, like a phosphorescent
// glow-in-the-dark star. Because the fade is computed analytically from each
// wave's age and the surface distance, there's no per-surface state to store:
//   time-since-passed  tsp = age - distance/speed
//   glow               = clamp(1 - tsp / glowTime, 0, 1)   (0 if tsp < 0)
// The freshest points (tsp ~ 0, i.e. the moving front) are brightest — that's the
// ripple — and everything it has already swept lingers and fades.
//
// The uniforms are shared and injected into every revealable material via
// onBeforeCompile, so walls, floor, ceiling and entities all glow together.
// -----------------------------------------------------------------------------

export const ECHO_MAX = 24;    // max simultaneous fading wavefronts
export const GLOW_TIME = 15.0; // seconds for a lit surface to fade back to black
export const WAVE_SPEED = 26.0; // wavefront expansion speed (must match sonar.js)

export const revealUniforms = {
  // Each wave: xyz = origin, w = age in seconds since it was emitted.
  uWaves: { value: Array.from({ length: ECHO_MAX }, () => new THREE.Vector4(0, 0, 0, -999)) },
  uWaveOn: { value: new Float32Array(ECHO_MAX) }, // 1 = active, 0 = inactive
  uWaveSpeed: { value: WAVE_SPEED },
  uGlowTime: { value: GLOW_TIME },
  uEchoColor: { value: new THREE.Color(0x39ff14) }, // neon green
};

export function installReveal(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaves = revealUniforms.uWaves;
    shader.uniforms.uWaveOn = revealUniforms.uWaveOn;
    shader.uniforms.uWaveSpeed = revealUniforms.uWaveSpeed;
    shader.uniforms.uGlowTime = revealUniforms.uGlowTime;
    shader.uniforms.uEchoColor = revealUniforms.uEchoColor;

    // World position (accounting for instancing) -> fragment shader.
    shader.vertexShader =
      "varying vec3 vEchoWorld;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec4 echoW = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          echoW = instanceMatrix * echoW;
        #endif
        echoW = modelMatrix * echoW;
        vEchoWorld = echoW.xyz;`
      );

    shader.fragmentShader =
      `#define ECHO_MAX ${ECHO_MAX}
      uniform vec4 uWaves[ECHO_MAX];
      uniform float uWaveOn[ECHO_MAX];
      uniform float uWaveSpeed;
      uniform float uGlowTime;
      uniform vec3 uEchoColor;
      varying vec3 vEchoWorld;\n` +
      shader.fragmentShader.replace(
        "#include <output_fragment>",
        // The loop is UNROLLED by Three's preprocessor (#pragma unroll_loop_*),
        // turning uWaves[ i ] into constant indices — dynamic indexing of a
        // uniform array in a fragment shader fails to compile on many drivers
        // (that was the "sonar does nothing / world stays black" bug). The
        // literal 24 must match ECHO_MAX. No `float x =` declarations inside the
        // loop body (unrolling would redeclare them); temporaries live outside.
        `float echoR = 0.0;
        float echoTsp = 0.0;
        #pragma unroll_loop_start
        for ( int i = 0; i < 24; i ++ ) {
          echoTsp = uWaves[ i ].w - distance( vEchoWorld, uWaves[ i ].xyz ) / uWaveSpeed;
          echoR += ( clamp( 1.0 - echoTsp / uGlowTime, 0.0, 1.0 ) + ( 1.0 - smoothstep( 0.0, 0.12, echoTsp ) ) * 0.5 ) * step( 0.0, echoTsp ) * uWaveOn[ i ];
        }
        #pragma unroll_loop_end
        echoR = clamp( echoR, 0.0, 1.6 );
        outgoingLight += ( diffuseColor.rgb + uEchoColor * 0.6 ) * echoR;
        #include <output_fragment>`
      );
  };
  material.customProgramCacheKey = () => "echoReveal";
  material.needsUpdate = true;
}
