// Word lists for the spelling check of the Write editor (public/js/texlint.js). Nothing is vendored: the English
// list is built once per server run from the dictionary file of the operating system (macOS: /usr/share/dict/words),
// lower-cased, plus the modern and technical words below that a 1934 dictionary does not have. Inflected forms
// (plurals, -ed, -ing ...) and British spellings are not in the list: the checker in the browser strips them.
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

// (Windows has no such file: there "/usr/share/dict/words" would mean C:\usr\share\dict\words, a folder anyone can
// make, so nothing is read and the spelling check is off)
const SOURCES = process.platform === 'win32' ? []
  : ['/usr/share/dict/words', '/usr/share/dict/web2', '/usr/share/dict/american-english', '/usr/share/dict/british-english'];

// base forms only; one string so the list stays readable
const EXTRA = `
a i ok
am is are was were been being has had having does did done doing went gone goes got gotten gave given took taken made said saw seen came knew known
thought told felt left kept held brought began begun wrote written ran sat stood lost paid met led read grew grown drew drawn drove driven broke broken
spoke spoken chose chosen fell fallen found built sent spent caught taught bought fought sought sold meant heard understood showed shown threw thrown
flew flown wore worn tore torn bore born borne swam swum sang sung rang rung drank drunk sank sunk shrank shrunk hung struck stuck swept slept wept dealt
dug fed fled forgot forgotten forgave forgiven froze frozen hid hidden laid lain lit rode ridden rose risen shook shaken shot stole stolen swore sworn
woke woken won wound bent bound bred clung crept dwelt ground hurt lent overcame overcome redid redone reran rebuilt underwent undergone undertook
undertaken withdrew withdrawn withheld withstood arose arisen became become beheld beset bit bitten bled blew blown fit forbade forbidden foresaw
foreseen forecast mistook mistaken outdid outdone overdid overdone overtook overtaken sped spun split spread sprang sprung stung strove striven strode
swung thrust trod trodden upheld upset wrung misled misread misunderstood rewrote rewritten retook retaken resent rethought unbound unseen
men women children feet teeth mice geese oxen people lives knives wives leaves halves selves shelves wolves loaves thieves calves criteria phenomena
data media analyses hypotheses theses bases axes crises diagnoses syntheses parentheses ellipses indices matrices vertices appendices vortices
nuclei radii foci stimuli loci fungi cacti alumni bacteria curricula spectra strata maxima minima optima extrema schemata formulae antennae
vertebrae larvae algae genera corpora emphases prognoses metamorphoses
better best worse worst further furthest farther farthest less least more most elder eldest fewer fewest
these those whose whom ours yours theirs hers its himself herself itself themselves ourselves yourself yourselves myself oneself others
box hang
inline timeline numeric lowercase uppercase unicode info keyword filename hexadecimal config endpoint midpoint download upload timezone debug
linux unix macos shortcut bitmap standalone typeface byte megabyte gigabyte kilobyte boilerplate workaround popup anymore artwork monospaced
avatar freeware goto readonly async builtin addon timeout upfront freeform anytime offsite handoff tradeoff speedup checkpoint workstation
workspace tabletop countertop stovetop handheld backpack joystick payload fractal quantile datapoint crowdsource posteriori priori
disambiguate inpainting mimicking mimicked omnidirectional holonomic nonholonomic exteroception parkour surfel submap sparsify sparsified
arcsin arccos arctan visuomotor sensorimotor locomanipulation locomotion teleop actuate underactuated overactuated kinodynamic nerf
toolbar sidebar dropdown checkbox screenshot username login homepage hyperlink spreadsheet touchscreen smartwatch wifi bluetooth podcast
espresso fridge cookware placemat marshmallow frisbee backflip proactive exascale
non pre multi semi anti sub meta pseudo quasi inter intra hyper micro macro nano tele auto mis via vs versus etc et al cf ie eg
online offline internet website web email blog app apps software hardware firmware middleware smartphone laptop desktop
database dataset datasets metadata timestamp workflow pipeline toolkit toolbox codebase plugin backend frontend
runtime bitrate bandwidth throughput latency scalable scalability interoperability reproducibility replicability
benchmark baseline ablation ablate hyperparameter hyperparameters parameterize parameterization reparameterize
tokenizer tokenize token embedding embed encoder decoder autoencoder transformer backbone backpropagation backpropagate
convolution convolutional deconvolution recurrent feedforward perceptron softmax sigmoid logit logits relu dropout
pretrain pretrained finetune finetuned overfit overfitting underfit regularize regularizer regularization
minibatch batch epoch learnable trainable differentiable discretize discretization discretized quantize quantization
stochastic deterministic probabilistic variational generative discriminative adversarial contrastive supervised
unsupervised multimodal unimodal multitask multiview crossmodal bimodal egocentric allocentric
bayesian gaussian markov markovian laplacian jacobian hessian lagrangian hamiltonian euclidean riemannian cartesian
boolean poisson bernoulli dirichlet kalman lipschitz hilbert fourier wasserstein kullback leibler monte carlo
bellman lyapunov newton euler gauss jensen shannon cauchy schwarz chebyshev
eigenvalue eigenvector eigenvalues eigenvectors eigen affine homogeneous isotropic anisotropic orthonormal
invertible bijective injective surjective monotonic nonlinear nonconvex convex piecewise elementwise pointwise
pairwise stepwise covariance heteroscedastic homoscedastic autoregressive
robotic robotics teleoperation teleoperate teleoperated teleoperator manipulator gripper actuator actuation
kinematic kinematics dynamics odometry lidar radar sonar proprioception proprioceptive exteroceptive haptic tactile
affordance affordances waypoint waypoints rollout rollouts sim onboard offboard quadrotor quadcopter quadruped
humanoid bipedal legged wheeled drone drones manipulability dexterous dexterity bimanual backdrivable
servo servoing encoder gyroscope accelerometer inertial localization localize mapping voxel voxels voxelize
mesh meshes pointcloud occupancy raycast raycasting keypoint keypoints keyframe keyframes pixel pixels
photometric photorealistic rasterize rasterization renderer radiance splatting splat tensor tensors
segmentation semantic semantics detector classifier regressor estimator planner controller optimizer optimiser
solver sampler scheduler simulator emulator tracker
upsample downsample upsampling downsampling subsample resample interpolate extrapolate
feedback feedforward setpoint closed-loop torque torques impedance admittance compliant compliance
reinforcement imitation demonstration demonstrations policy policies reward rewards trajectory trajectories
subgoal subgoals subtask subtasks subproblem submodule subnetwork subspace subset superset
real-time realtime lookup lookahead timestep timesteps horizon receding
transformer attention self-attention diffusion denoise denoising denoiser diffuse latent prior posterior likelihood
logarithm logarithmic exponential polynomial quadratic cubic bilinear trilinear
analytic analytical heuristic heuristics combinatorial tractable intractable scalably
outperform outperforms outperformed underperform state-of-the-art
preprocess preprocessing postprocess postprocessing preprint arxiv bibtex latex
url urls api apis gpu gpus cpu cpus ram hz khz mhz ghz kb mb gb ms fps rgb rgbd
todo fixme
demo webcam approx wrt spatio visuotactile intro
grey programme artefact aluminium sceptical cheque tyre plough storey kerb
`.split(/\s+/).filter(Boolean).flatMap((w) => w.split('-')).filter((w) => /^[a-z]+$/.test(w));

let cache; // undefined = not built yet, null = no dictionary on this computer, else {plain, gzip, etag, count, source}
function wordList() {
  if (cache !== undefined) return cache;
  cache = null;
  for (const file of SOURCES) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const words = new Set(EXTRA);
    for (const raw of text.split('\n')) {
      const w = raw.trim().toLowerCase();
      if (w.length >= 2 && w.length <= 30 && /^[a-z]+$/.test(w)) words.add(w); // single letters are never checked
    }
    if (words.size < 5000) continue; // not a real dictionary
    const plain = Buffer.from([...words].sort().join('\n'), 'utf8');
    cache = { plain, gzip: zlib.gzipSync(plain), etag: '"' + crypto.createHash('sha1').update(plain).digest('hex').slice(0, 16) + '"', count: words.size, source: file };
    break;
  }
  return cache;
}
const available = () => SOURCES.some((f) => { try { return fs.statSync(f).size > 20000; } catch { return false; } });

// The words of BibTeX text and of library items (names of authors, words of titles and venues): they are right by
// definition, so the spelling check accepts them. Lower-cased, letters only, at least 3 letters.
function wordsOf(texts, cap = 30000) {
  const out = new Set();
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    for (const m of t.matchAll(/[A-Za-z]{3,30}/g)) { if (out.size >= cap) return [...out]; out.add(m[0].toLowerCase()); }
  }
  return [...out];
}
// a word the user adds to a project dictionary: letters (any script), apostrophes and hyphens inside, 2-40 characters
function cleanWord(w) {
  const s = String(w == null ? '' : w).normalize('NFC').trim().replace(/’/g, "'");
  return /^\p{L}[\p{L}'-]{0,38}\p{L}$/u.test(s) ? s : null;
}

module.exports = { wordList, available, wordsOf, cleanWord };
