// reveal.js
// -----------------------------------------------------------------------------
// The sonar-reveal effect (expanding rings + glow-in-the-dark), done by patching
// every visible material's shader.
//
// KEY LESSON from the earlier broken version: the injected code must splice into
// a shader chunk that ACTUALLY EXISTS, or String.replace silently no-ops and the
// reveal never runs (compiles fine, shows nothing). We inject at:
//   * vertex:   #include <begin_vertex>      (present in every Three vertex shader)
//   * fragment: #include <dithering_fragment> (present at the end of every frag
//               shader) — and we add straight onto gl_FragColor, which is always
//               defined by that point. No dependence on material-specific names.
//
// Per ring: origin (xyz) + age (w). Radius = age * speed (grows with dt). A
// surface lights the moment the ring front reaches it (tsp ~ 0) and then fades
// over uGlowTime seconds — the glow-in-the-dark persistence.
// -----------------------------------------------------------------------------

export const ECHO_MAX = 12;    // max simultaneous rings
export const GLOW_TIME = 12.0; // seconds for a lit surface to fade back to black
export const WAVE_SPEED = 26.0; // ring expansion speed (units/second)

export const revealUniforms = {
  uWaves: { value: Array.from({ length: ECHO_MAX }, () => new THREE.Vector4(0, 0, 0, -999)) }, // xyz origin, w age
  uWaveOn: { value: new Float32Array(ECHO_MAX) }, // 1 = active, 0 = inactive
  uWaveSpeed: { value: WAVE_SPEED },
  uGlowTime: { value: GLOW_TIME },
  uEchoColor: { value: new THREE.Color(0x39ff14) }, // neon green
};

export function installReveal(material) {
  material.onBeforeCompile = (shader) => {
    // Share the SAME uniform objects with every patched material so a single
    // per-frame update (in sonar.js) drives them all.
    Object.assign(shader.uniforms, {
      uWaves: revealUniforms.uWaves,
      uWaveOn: revealUniforms.uWaveOn,
      uWaveSpeed: revealUniforms.uWaveSpeed,
      uGlowTime: revealUniforms.uGlowTime,
      uEchoColor: revealUniforms.uEchoColor,
    });

    // Vertex: expose the fragment's world position (instancing-aware).
    shader.vertexShader =
      "varying vec3 vEchoWorld;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vec4 echoWP = vec4( transformed, 1.0 );
         #ifdef USE_INSTANCING
           echoWP = instanceMatrix * echoWP;
         #endif
         vEchoWorld = ( modelMatrix * echoWP ).xyz;`
      );

    // Fragment: reveal the surface's OWN colour/texture (tinted green) where a
    // ring passes — not flat green. `echoSurface` captures the material's albedo
    // right after the texture is sampled, then we add it back at the end scaled
    // by the ring glow. The loop is unrolled (constant indices) — dynamic
    // uniform-array indexing fails on many drivers. Literal 12 must match
    // ECHO_MAX. Temporaries declared once so unrolled copies don't redeclare.
    shader.fragmentShader =
      `uniform vec4 uWaves[${ECHO_MAX}];
       uniform float uWaveOn[${ECHO_MAX}];
       uniform float uWaveSpeed;
       uniform float uGlowTime;
       uniform vec3 uEchoColor;
       varying vec3 vEchoWorld;
       vec3 echoSurface = vec3( 0.0 );\n` +
      shader.fragmentShader
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
           echoSurface = diffuseColor.rgb;` // remember the real surface colour
        )
        .replace(
          "#include <dithering_fragment>",
          `{
            float echoR = 0.0;
            float echoTsp = 0.0;
            #pragma unroll_loop_start
            for ( int i = 0; i < 12; i ++ ) {
              echoTsp = uWaves[ i ].w - distance( vEchoWorld, uWaves[ i ].xyz ) / uWaveSpeed;
              echoR += clamp( 1.0 - echoTsp / uGlowTime, 0.0, 1.0 ) * step( 0.0, echoTsp ) * uWaveOn[ i ];
            }
            #pragma unroll_loop_end
            // Peak ~50% brightness (the 0.5), then fades out with echoR.
            echoR = clamp( echoR, 0.0, 1.0 );
            gl_FragColor.rgb += ( echoSurface * 0.5 + uEchoColor * 0.22 ) * echoR;
          }
          #include <dithering_fragment>`
        );
  };
  material.customProgramCacheKey = () => "echoRing";
  material.needsUpdate = true;
}
