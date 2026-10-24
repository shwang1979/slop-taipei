// Shared procedural audio and continuously running, mono vehicle voices. Spatial placement and overall mixing
// belong to the caller; every source and processing node created by a voice is released by dispose().

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Movement and tone controls only need one value per audio block. Set every parameter on these nodes:
// even an unused a-rate parameter can make the browser recalculate spatial/filter math for every sample.
// Oscillator modulation and gain envelopes keep their default audio rate.
export function setControlRate(...parameters) {
  for (const parameter of parameters) {
    if (parameter?.automationRate !== undefined) parameter.automationRate = 'k-rate';
  }
}

function randomSequence(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function normalizeLoop(buffer, rms, ceiling = 0.9) {
  const data = buffer.getChannelData(0);
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i];
  mean /= data.length;
  let energy = 0, peak = 0;
  for (let i = 0; i < data.length; i++) {
    data[i] -= mean;
    energy += data[i] * data[i];
    peak = Math.max(peak, Math.abs(data[i]));
  }
  const scale = Math.min(ceiling / Math.max(peak, 0.0001), rms / Math.max(Math.sqrt(energy / data.length), 0.0001));
  for (let i = 0; i < data.length; i++) data[i] *= scale;
  return buffer;
}

function combustionBuffers(context, cylinders, diesel, seed) {
  const rate = context.sampleRate;
  const referenceRPM = 1200;
  const highReferenceRPM = diesel ? 2400 : 3600;
  const cycles = 20; // Twenty complete four-stroke cycles, not a single repeating waveform.
  const mechanical = context.createBuffer(1, Math.round(cycles * 120 / referenceRPM * rate), rate);
  const random = randomSequence(seed);
  const cylinderStrength = Array.from({ length: cylinders }, () => 0.83 + random() * 0.34);
  const cylinderDelay = Array.from({ length: cylinders }, () => (random() - 0.5) * 0.035);
  const resonance = (diesel ? 93 : cylinders === 6 ? 118 : 145) * (0.97 + random() * 0.06);
  const duration = Math.round(rate * (diesel ? 0.062 : 0.048));

  function exhaustBuffer(rpm, clatter) {
    const length = Math.round(cycles * 120 / rpm * rate);
    const buffer = context.createBuffer(1, length, rate);
    const pressure = buffer.getChannelData(0);
    const interval = length / (cycles * cylinders);
    // Separate timing from sample noise so both RPM banks share the same firing phases and cylinder balance.
    const timing = randomSequence(seed), noise = randomSequence(seed ^ 0x65786861);
    for (let firing = 0; firing < cycles * cylinders; firing++) {
      const cylinder = firing % cylinders;
      let index = Math.round((firing + cylinderDelay[cylinder] + (timing() - 0.5) * 0.012) * interval);
      index = (index + length) % length;
      const strength = cylinderStrength[cylinder] * (0.92 + timing() * 0.16);
      const decay = (diesel ? 0.019 : 0.012) * (0.95 + timing() * 0.1);
      let lowNoise = 0;
      for (let i = 0; i < duration; i++) {
        const t = i / rate;
        const white = noise() * 2 - 1;
        lowNoise += (white - lowNoise) * 0.16;
        const attack = 1 - Math.exp(-t / 0.00065);
        const tail = Math.exp(-t / decay);
        // Keep the exhaust's resonance and decay in seconds as firing frequency increases. Pitching one
        // idle loop through the entire rev range would shrink every pulse into a thin, high-pitched buzz.
        const release = Math.exp(-t / 0.0022) - 0.36 * Math.exp(-t / 0.009);
        const body = Math.sin(2 * Math.PI * resonance * t) * tail * 0.34;
        pressure[index] += strength * attack * (release + body + lowNoise * tail * (diesel ? 0.5 : 0.28));
        if (clatter) {
          // Injector/valve impacts contain much more noise than ringing, with a separate delayed tappet click.
          const valveTime = Math.max(0, t - 0.009);
          const valve = t > 0.009 ? Math.exp(-valveTime / 0.0016) * (white * 0.65 + Math.sin(valveTime * 14900) * 0.12) : 0;
          clatter[index] += strength * (white * attack * Math.exp(-t / (diesel ? 0.0036 : 0.0022)) + valve * 0.35);
        }
        if (++index === length) index = 0;
      }
    }
    return normalizeLoop(buffer, 0.30);
  }

  return {
    exhaust: exhaustBuffer(referenceRPM, mechanical.getChannelData(0)),
    highExhaust: exhaustBuffer(highReferenceRPM),
    mechanical: normalizeLoop(mechanical, diesel ? 0.22 : 0.18, 0.85),
    referenceRPM,
    highReferenceRPM
  };
}

function rotorBuffers(context) {
  const rate = context.sampleRate;
  const revolutions = 16, blades = 4, revolutionsPerSecond = 5.2;
  const length = Math.round(rate * revolutions / revolutionsPerSecond);
  const rotor = context.createBuffer(1, length, rate);
  const envelope = context.createBuffer(1, length, rate);
  const data = rotor.getChannelData(0), modulation = envelope.getChannelData(0);
  const random = randomSequence(0x726f746f);
  const strengths = [1, 0.73, 0.96, 0.76];
  const interval = length / (revolutions * blades);
  for (let blade = 0; blade < revolutions * blades; blade++) {
    let index = Math.round((blade + (random() - 0.5) * 0.012) * interval);
    index = (index + length) % length;
    const strength = strengths[blade % blades] * (0.94 + random() * 0.12);
    let turbulence = 0;
    for (let i = 0; i < rate * 0.085; i++) {
      const t = i / rate;
      turbulence += (random() * 2 - 1 - turbulence) * 0.24;
      const attack = 1 - Math.exp(-t / 0.0003);
      const pressure = (1 - t / 0.0032) * Math.exp(-t / 0.0032);
      const body = Math.sin(t * 2 * Math.PI * 52) * Math.exp(-t / 0.021) * 0.32;
      // A compact pressure pulse and low body give each blade weight; most wash is a separate modulated layer.
      const slapTime = t - 0.005;
      const slap = slapTime > 0 ? (1 - slapTime / 0.0008) * Math.exp(-slapTime / 0.0008) * 0.24 : 0;
      const wash = attack * Math.exp(-t / 0.016);
      data[index] += strength * (pressure * attack + body + slap + turbulence * wash * 0.42);
      modulation[index] += strength * wash;
      if (++index === length) index = 0;
    }
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, modulation[i]);
  for (let i = 0; i < length; i++) modulation[i] /= peak;
  return { rotor: normalizeLoop(rotor, 0.29), envelope };
}

function turbineBuffer(context) {
  const rate = context.sampleRate;
  const buffer = context.createBuffer(1, Math.round(rate * 2), rate);
  const data = buffer.getChannelData(0), random = randomSequence(0x74757262);
  let lowNoise = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / rate;
    const white = random() * 2 - 1;
    lowNoise += (white - lowNoise) * 0.18;
    // Two close turbine tones beat gently above the gearbox. Integer cycles and periodic phase modulation
    // wrap continuously; baking them once avoids a stack of oscillators for every helicopter voice.
    const flutter = Math.sin(2 * Math.PI * 23 * t) * 0.12;
    data[i] = Math.sin(2 * Math.PI * 1580 * t + flutter) * 0.30
      + Math.sin(2 * Math.PI * 1593 * t - flutter) * 0.24
      + Math.sin(2 * Math.PI * 3160 * t + flutter * 2) * 0.12
      + Math.sin(2 * Math.PI * 790 * t) * 0.08 + (white - lowNoise) * 0.25;
  }
  return normalizeLoop(buffer, 0.22, 0.8);
}

function sirenSweepWave(context) {
  const real = new Float32Array(25), imaginary = new Float32Array(25);
  // Electronic wail/yelp circuits use a nearly triangular control voltage, with softened turning points.
  for (let harmonic = 1; harmonic < real.length; harmonic++) {
    for (let i = 0; i < 512; i++) {
      const phase = i / 512;
      const ramp = phase < 0.46 ? phase / 0.46 : (1 - phase) / 0.54;
      const triangle = 2 * ramp - 1;
      const value = triangle * 0.88 + Math.sin(triangle * Math.PI / 2) * 0.12;
      real[harmonic] += value * Math.cos(2 * Math.PI * harmonic * phase) / 256;
      imaginary[harmonic] += value * Math.sin(2 * Math.PI * harmonic * phase) / 256;
    }
  }
  return context.createPeriodicWave(real, imaginary);
}

export function createSynthResources(context) {
  const sampleRate = context.sampleRate;
  const noise = context.createBuffer(1, Math.round(sampleRate * 2), sampleRate);
  const samples = noise.getChannelData(0);
  const random = randomSequence(0x6e796361);
  for (let i = 0; i < samples.length; i++) samples[i] = random() * 2 - 1;

  // Warm each filter with one complete cycle before writing. Its state then wraps with the buffer, so the loop
  // boundary is an ordinary noise sample transition rather than a restart of the filter or an amplitude fade.
  const coefficient = Math.exp(-2 * Math.PI * 7000 / sampleRate);
  for (let pass = 0; pass < 2; pass++) {
    let previous = 0;
    for (let i = 0; i < samples.length; i++) previous += (samples[i] - previous) * (1 - coefficient);
    for (let i = 0; i < samples.length; i++) {
      previous += (samples[i] - previous) * (1 - coefficient);
      samples[i] = previous;
    }
  }
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length;
  let peak = 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) {
    samples[i] -= mean;
    peak = Math.max(peak, Math.abs(samples[i]));
    energy += samples[i] * samples[i];
  }
  const scale = Math.min(0.95 / peak, 0.30 / Math.sqrt(energy / samples.length));
  for (let i = 0; i < samples.length; i++) samples[i] *= scale;

  const impulse = context.createBuffer(2, Math.round(sampleRate * 0.7), sampleRate);
  const reflections = [0.017, 0.034, 0.061, 0.097, 0.153, 0.231];
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    const rand = randomSequence(0x626c6f63 + channel * 7919);
    let filtered = 0;
    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      filtered += (rand() * 2 - 1 - filtered) * 0.35;
      const fadeIn = clamp((t - 0.012) / 0.035, 0, 1);
      const fadeOut = Math.min(1, (data.length - 1 - i) / (sampleRate * 0.04));
      data[i] = filtered * Math.exp(-t / 0.13) * fadeIn * fadeOut * 0.012;
    }
    for (let tap = 0; tap < reflections.length; tap++) {
      const start = Math.round((reflections[tap] + channel * (tap % 2 ? -0.0011 : 0.0017)) * sampleRate);
      const width = Math.round(sampleRate * (0.0008 + tap * 0.0002));
      const amplitude = 0.30 * Math.exp(-tap * 0.48);
      for (let i = 0; i < width; i++) {
        data[start + i] += (rand() * 2 - 1) * Math.sin(Math.PI * i / width) * amplitude;
      }
    }
  }

  const wave = (harmonics) => context.createPeriodicWave(new Float32Array(harmonics.length), new Float32Array(harmonics));
  const helicopter = rotorBuffers(context);
  return {
    noise,
    impulse,
    combustion: {
      sedan: combustionBuffers(context, 4, false, 0x73656461),
      suv: combustionBuffers(context, 6, false, 0x73757631),
      bus: combustionBuffers(context, 6, true, 0x64696573)
    },
    rotor: helicopter.rotor,
    rotorEnvelope: helicopter.envelope,
    turbine: turbineBuffer(context),
    sirenWave: wave([0, 1, 0.13, 0.29, 0.055, 0.11, 0.025, 0.045, 0.012, 0.018]),
    sirenSweep: sirenSweepWave(context),
    voiceSerial: 0
  };
}

// Keep only meaningful target changes. Replacing future events bounds the scheduling horizon; setTargetAtTime
// starts from the value reached by the preceding ramp, including when an update interrupts that ramp.
function smoothParameter(parameter, timeConstant = 0.07, epsilon = 0.0001, snapInitial = false) {
  let target = NaN;
  return (value, now) => {
    if (Math.abs(value - target) < epsilon) return;
    parameter.cancelScheduledValues(now);
    if (snapInitial && Number.isNaN(target)) parameter.setValueAtTime(value, now);
    else parameter.setTargetAtTime(value, now, timeConstant);
    target = value;
  };
}

export function createMotorVoice(context, resources, kind, output) {
  if (!['sedan', 'suv', 'bus', 'helicopter', 'scooter', 'siren'].includes(kind)) {
    throw new RangeError(`Unknown motor voice: ${kind}`);
  }
  const nodes = [];
  const sources = [];
  const serial = resources.voiceSerial = (resources.voiceSerial || 0) + 1;
  let disposed = false;
  let lastSeed = NaN;
  let variation = 0.5;
  const own = (node) => { nodes.push(node); return node; };
  const gain = (value = 0) => {
    const node = own(context.createGain());
    node.gain.value = value;
    return node;
  };
  const filter = (type, frequency, q = 0.7) => {
    const node = own(context.createBiquadFilter());
    setControlRate(node.frequency, node.detune, node.Q, node.gain);
    node.type = type;
    node.frequency.value = Math.min(frequency, context.sampleRate * 0.45);
    node.Q.value = q;
    return node;
  };
  const oscillator = (type, frequency) => {
    const node = own(context.createOscillator());
    if (typeof type === 'string') node.type = type;
    else node.setPeriodicWave(type);
    node.frequency.value = frequency;
    sources.push(node);
    return node;
  };
  const loop = (buffer = resources.noise) => {
    const node = own(context.createBufferSource());
    node.buffer = buffer;
    node.loop = true;
    sources.push(node);
    return node;
  };
  const mix = gain();
  mix.channelCount = 1;
  mix.channelCountMode = 'explicit';
  mix.connect(output);
  let render;

  if (kind === 'sedan' || kind === 'suv' || kind === 'bus') {
    const bus = kind === 'bus';
    const suv = kind === 'suv';
    const sound = resources.combustion[kind];
    const bankRatio = sound.highExhaust.duration / sound.exhaust.duration;
    const idle = bus ? 620 : suv ? 710 : 780;
    const ratios = bus ? [320, 205, 145, 108, 82] : [500, 325, 230, 170, 130];
    let gear = 0, rpm = idle, throttle = 0, previousTime = -1, gearLock = 0, shiftUntil = 0;
    const exhaust = loop(sound.exhaust);
    const highExhaust = loop(sound.highExhaust);
    highExhaust.playbackRate.value = bankRatio;
    const lowBankGain = gain(1), highBankGain = gain();
    const exhaustFilter = filter('lowpass', 500, 0.65);
    const exhaustGain = gain();
    exhaust.connect(lowBankGain).connect(exhaustFilter);
    highExhaust.connect(highBankGain).connect(exhaustFilter);
    exhaustFilter.connect(exhaustGain).connect(mix);
    const mechanism = loop(sound.mechanical);
    const mechanismFilter = filter('bandpass', bus ? 1400 : 1700, 0.45);
    const mechanismGain = gain();
    mechanism.connect(mechanismFilter).connect(mechanismGain).connect(mix);
    const road = loop();
    const roadHighpass = filter('highpass', 260, 0.5);
    const roadLowpass = filter('lowpass', 3200, 0.5);
    const roadGain = gain();
    road.connect(roadHighpass).connect(roadLowpass).connect(roadGain).connect(mix);
    const exhaustRate = smoothParameter(exhaust.playbackRate, 0.035, 0.0005, true);
    const highExhaustRate = smoothParameter(highExhaust.playbackRate, 0.035, 0.0005 * bankRatio, true);
    const lowBankLevel = smoothParameter(lowBankGain.gain, 0.07, 0.0001, true);
    const highBankLevel = smoothParameter(highBankGain.gain, 0.07, 0.0001, true);
    const mechanicalRate = smoothParameter(mechanism.playbackRate, 0.035, 0.0005, true);
    const exhaustCutoff = smoothParameter(exhaustFilter.frequency, 0.07, 1);
    const exhaustLevel = smoothParameter(exhaustGain.gain, 0.055);
    const mechanicalFrequency = smoothParameter(mechanismFilter.frequency, 0.12, 1);
    const mechanicalLevel = smoothParameter(mechanismGain.gain, 0.09);
    const roadLevel = smoothParameter(roadGain.gain, 0.18);
    const roadFrequency = smoothParameter(roadLowpass.frequency, 0.18, 1);
    const noiseRate = smoothParameter(road.playbackRate, 0.12, 0.001);
    render = (speed, load, doppler, now) => {
      const first = previousTime < 0;
      const dt = first ? 0.1 : clamp(now - previousTime, 0, 0.5);
      previousTime = now;
      throttle = first ? load : throttle + (load - throttle) * (1 - Math.exp(-dt / (load > throttle ? 0.14 : 0.32)));
      const shiftRPM = (bus ? 1700 : 2700) + throttle * (bus ? 950 : 2900);
      if (speed < 0.6) {
        // A fresh launch starts in first immediately, even after a hard stop from top gear.
        gear = 0;
        gearLock = shiftUntil = 0;
      } else if (first) {
        while (gear < ratios.length - 1 && speed * ratios[gear] > shiftRPM) gear++;
      } else if (now >= gearLock) {
        const oldGear = gear;
        const wheelRPM = speed * ratios[gear];
        if (gear < ratios.length - 1 && wheelRPM > shiftRPM) gear++;
        else if (gear > 0 && speed * ratios[gear - 1] < shiftRPM * 0.82
          && (wheelRPM < (bus ? 1000 : 1600) || (throttle > 0.65 && wheelRPM < shiftRPM * 0.55))) gear--;
        if (gear !== oldGear) {
          gearLock = now + 0.65;
          if (gear > oldGear) shiftUntil = now + 0.14;
        }
      }
      // Wheel-coupled RPM, with torque-converter slip at low speed. Coasting retains engine braking rather than
      // dropping straight to idle; hysteresis and a minimum gear dwell prevent hunting around a shift boundary.
      const slip = throttle * (bus ? 600 : 1500) * Math.max(0.12, 1 - speed / 16);
      const targetRPM = clamp(Math.max(idle, speed * ratios[gear]) + slip, idle, bus ? 2900 : 6200);
      rpm = first ? targetRPM : rpm + (targetRPM - rpm) * (1 - Math.exp(-dt / (targetRPM > rpm ? 0.12 : 0.075)));
      const pitch = (0.97 + variation * 0.06) * doppler;
      const effort = Math.min(1, throttle + speed * 0.005);
      const torque = now < shiftUntil ? 0.52 : 1;
      const rolling = Math.min(1.35, speed / 28);
      exhaustRate(rpm / sound.referenceRPM * pitch, now);
      highExhaustRate(rpm / sound.referenceRPM * pitch * bankRatio, now);
      // Same cycle count, starting phase and proportional rates keep the firings in step. Equal-power
      // blending avoids a volume dip between the banks' different exhaust resonances.
      const bank = clamp((rpm - sound.referenceRPM) / (sound.highReferenceRPM - sound.referenceRPM), 0, 1);
      const blend = bank * bank * (3 - 2 * bank);
      lowBankLevel(Math.cos(blend * Math.PI / 2), now);
      highBankLevel(Math.sin(blend * Math.PI / 2), now);
      mechanicalRate(rpm / sound.referenceRPM * pitch, now);
      exhaustCutoff((bus ? 480 : 650) + effort * (bus ? 1400 : 1800) + rpm * 0.24, now);
      exhaustLevel(((bus ? 0.16 : suv ? 0.13 : 0.11) + effort * (bus ? 0.22 : 0.26)) * torque, now);
      mechanicalFrequency(((bus ? 1050 : 1250) + rpm * 0.12) * doppler, now);
      mechanicalLevel(((bus ? 0.10 : 0.03) + effort * (bus ? 0.15 : 0.085)) * torque, now);
      // Tire contact is broadband and becomes the dominant sound of a car passing at speed off-throttle.
      roadLevel(Math.pow(rolling, 1.25) * (bus ? 0.44 : 0.36) * (1 - throttle * 0.5), now);
      roadFrequency((2200 + Math.min(1, rolling) * 2400) * doppler, now);
      noiseRate(doppler * (0.96 + variation * 0.08), now);
    };
  } else if (kind === 'helicopter') {
    const rotor = loop(resources.rotor);
    const rotorFilter = filter('lowpass', 1500, 0.5);
    const rotorGain = gain();
    rotor.connect(rotorFilter).connect(rotorGain).connect(mix);
    const air = loop();
    const washFilter = filter('lowpass', 1400, 0.5);
    const washGain = gain();
    air.connect(washFilter).connect(washGain).connect(mix);
    const bladeEnvelope = loop(resources.rotorEnvelope);
    const bladeDepth = gain();
    bladeEnvelope.connect(bladeDepth).connect(washGain.gain);
    const turbine = loop(resources.turbine);
    const turbineFilter = filter('bandpass', 2400, 0.55);
    const turbineGain = gain();
    turbine.connect(turbineFilter).connect(turbineGain).connect(mix);
    const rotorRate = smoothParameter(rotor.playbackRate, 0.30, 0.0004, true);
    const envelopeRate = smoothParameter(bladeEnvelope.playbackRate, 0.30, 0.0004, true);
    const rotorLevel = smoothParameter(rotorGain.gain, 0.22);
    const rotorCutoff = smoothParameter(rotorFilter.frequency, 0.22, 1);
    const washLevel = smoothParameter(washGain.gain, 0.22);
    const bladeLevel = smoothParameter(bladeDepth.gain, 0.22);
    const washCutoff = smoothParameter(washFilter.frequency, 0.25, 1);
    const turbineFrequency = smoothParameter(turbineFilter.frequency, 0.25, 1);
    const turbineLevel = smoothParameter(turbineGain.gain, 0.22);
    const turbineRate = smoothParameter(turbine.playbackRate, 0.4, 0.0005, true);
    const noiseRate = smoothParameter(air.playbackRate, 0.15, 0.001);
    render = (speed, load, doppler, now, verticalSpeed) => {
      const flight = Math.min(1, speed / 40);
      const descent = clamp(-verticalSpeed / 10, 0, 1) * Math.min(1, speed / 10) * (1 - flight * 0.6);
      // A governed rotor changes speed very little: collective/forward flight primarily strengthen the blade slap
      // and turbulent wash. The pressure loop and its noise envelope share the same phase and playback rate.
      const rate = (0.994 + variation * 0.012 - load * 0.012 + flight * 0.004) * doppler;
      rotorRate(rate, now);
      envelopeRate(rate, now);
      rotorLevel(0.32 + load * 0.18 + descent * 0.12 + flight * 0.025, now);
      rotorCutoff((1150 + load * 700 + descent * 1800) * doppler, now);
      washLevel(0.022 + load * 0.025, now);
      bladeLevel(0.18 + load * 0.25 + descent * 0.25, now);
      washCutoff((800 + load * 650 + flight * 900) * doppler, now);
      turbineFrequency((2000 + load * 900) * doppler, now);
      turbineLevel(0.055 + load * 0.055, now);
      turbineRate((0.92 + load * 0.16) * doppler, now);
      noiseRate(doppler, now);
    };
  } else if (kind === 'scooter') {
    // 125 cc single-cylinder four-stroke behind a CVT (the 機車 sound): one firing every two revolutions, a buzzy
    // sawtooth & its octave through the exhaust; the belt holds the revs high while the speed builds
    const firing = oscillator('sawtooth', 14);
    const bodyFilter = filter('lowpass', 700, 1.1);
    const bodyGain = gain();
    firing.connect(bodyFilter).connect(bodyGain).connect(mix);
    const octave = oscillator('square', 28);
    const octaveFilter = filter('bandpass', 650, 1.4);
    const octaveGain = gain();
    octave.connect(octaveFilter).connect(octaveGain).connect(mix);
    const intake = loop();
    const intakeFilter = filter('bandpass', 1500, 0.9);
    const intakeGain = gain();
    intake.connect(intakeFilter).connect(intakeGain).connect(mix);
    const road = loop();
    const roadFilter = filter('lowpass', 1800, 0.6);
    const roadGain = gain();
    road.connect(roadFilter).connect(roadGain).connect(mix);
    const firingRate = smoothParameter(firing.frequency, 0.04, 0.05, true);
    const octaveRate = smoothParameter(octave.frequency, 0.04, 0.05, true);
    const bodyCutoff = smoothParameter(bodyFilter.frequency, 0.08, 1);
    const bodyLevel = smoothParameter(bodyGain.gain, 0.06);
    const octaveCutoff = smoothParameter(octaveFilter.frequency, 0.08, 1);
    const octaveLevel = smoothParameter(octaveGain.gain, 0.06);
    const intakeCutoff = smoothParameter(intakeFilter.frequency, 0.1, 1);
    const intakeLevel = smoothParameter(intakeGain.gain, 0.08);
    const roadLevel = smoothParameter(roadGain.gain, 0.15);
    const noiseRate = smoothParameter(road.playbackRate, 0.12, 0.001);
    let rpm = 1600;
    let throttle = 0;
    let previousTime = -1;
    render = (speed, load, doppler, now) => {
      const first = previousTime < 0;
      const dt = first ? 0.1 : clamp(now - previousTime, 0, 0.5);
      previousTime = now;
      throttle = first ? load : throttle + (load - throttle) * (1 - Math.exp(-dt / (load > throttle ? 0.08 : 0.25)));
      const targetRPM = clamp(1600 + throttle * 4800 + speed * 95, 1600, 8600);
      rpm = first ? targetRPM : rpm + (targetRPM - rpm) * (1 - Math.exp(-dt / (targetRPM > rpm ? 0.09 : 0.18)));
      const f = (rpm / 120) * (0.97 + variation * 0.06) * doppler;
      firingRate(f, now);
      octaveRate(f * 2, now);
      bodyCutoff((420 + throttle * 1500 + rpm * 0.09) * doppler, now);
      bodyLevel(0.1 + throttle * 0.2, now);
      octaveCutoff((520 + rpm * 0.06) * doppler, now);
      octaveLevel(0.025 + throttle * 0.05, now);
      intakeCutoff((1100 + rpm * 0.12) * doppler, now);
      intakeLevel(0.012 + throttle * 0.045, now);
      roadLevel(Math.pow(Math.min(1.2, speed / 16), 1.3) * 0.12, now);
      noiseRate(doppler, now);
    };
  } else {
    const siren = oscillator(resources.sirenWave, 1125);
    const highpass = filter('highpass', 480, 0.7);
    const hornBody = filter('peaking', 1750, 1.1);
    hornBody.gain.value = 3.5;
    const hornFilter = filter('lowpass', 4200, 0.65);
    const sirenGain = gain();
    siren.connect(highpass).connect(hornBody).connect(hornFilter).connect(sirenGain).connect(mix);
    const sweep = oscillator(resources.sirenSweep, 0.2);
    const sweepDepth = gain();
    sweep.connect(sweepDepth).connect(siren.frequency);
    const envelopeDepth = gain();
    sweep.connect(envelopeDepth).connect(sirenGain.gain);
    const sirenFrequency = smoothParameter(siren.frequency, 0.09, 0.1);
    const sweepFrequency = smoothParameter(sweep.frequency, 0.035, 0.002, true);
    const sweepRange = smoothParameter(sweepDepth.gain, 0.09, 0.1);
    const sirenLevel = smoothParameter(sirenGain.gain, 0.10);
    const envelopeLevel = smoothParameter(envelopeDepth.gain, 0.10);
    const sirenCutoff = smoothParameter(hornFilter.frequency, 0.12, 1);
    const hornFrequency = smoothParameter(hornBody.frequency, 0.12, 1);
    render = (speed, load, doppler, now) => {
      const pitch = (0.98 + variation * 0.04) * doppler;
      sirenFrequency(1125 * pitch, now);
      sweepRange(425 * pitch, now);
      // Hold a long wail, then briefly select yelp. Different cars switch independently; the oscillator
      // keeps its phase through a change, and Doppler shifts both the pitch and the sweep cadence.
      const yelp = (now + variation * 24) % 24 >= 19;
      sweepFrequency((yelp ? 3 : 0.2) * (0.97 + variation * 0.06) * doppler, now);
      sirenLevel(0.09, now);
      envelopeLevel(0.01, now);
      sirenCutoff(4200 * doppler, now);
      hornFrequency(1750 * doppler, now);
    };
  }

  function update({ speed = 0, load = 0, doppler = 1, seed = 0, verticalSpeed = 0 } = {}, now = context.currentTime) {
    if (disposed) return;
    const safeSeed = Number.isFinite(seed) ? seed : 0;
    if (safeSeed !== lastSeed) {
      const hash = Math.sin((safeSeed % 1048576) * 12.9898 + 78.233) * 43758.5453;
      variation = hash - Math.floor(hash);
      lastSeed = safeSeed;
    }
    const time = Math.max(context.currentTime, Number.isFinite(now) ? now : context.currentTime);
    render(
      Number.isFinite(speed) ? Math.min(Math.abs(speed), 100) : 0,
      Number.isFinite(load) ? clamp(load, 0, 1) : 0,
      Number.isFinite(doppler) ? clamp(doppler, 0.5, 2) : 1,
      time,
      Number.isFinite(verticalSpeed) ? clamp(verticalSpeed, -30, 30) : 0
    );
  }

  const startTime = context.currentTime;
  mix.gain.setTargetAtTime(1, startTime, 0.04);
  for (const source of sources) {
    if (source.buffer) source.start(startTime, ((serial * 0.61803398875) % 1) * source.buffer.duration);
    else source.start(startTime);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const source of sources) source.stop();
    for (const node of nodes) node.disconnect();
  }

  return { update, dispose };
}
