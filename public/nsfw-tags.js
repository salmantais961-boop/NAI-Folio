// Bump when tagging rules change so stored image ratings can be refreshed.
export const NSFW_RULES_VERSION = 2;

// Canonical terms are kept for display in META, including for compound matches.
const explicitTags = new Set(`
nsfw|very nsfw|not safe for work|explicit|sexually explicit|explicit content|rating:e|rating:explicit|rating:nsfw
r18|r-18|r18+|porn|porno|pornography|pornographic|hardcore porn|softcore porn|hentai|hentai artwork
nude|naked|nudity|full nudity|full frontal nudity|full frontal nude|frontal nudity|completely nude|completely naked|fully nude|fully naked|nude female|nude male|nude modeling|public nudity|exhibitionism|public indecency
clothed female nude male|clothed male nude female|clothed female nude female|clothed male nude male
topless female|breasts exposed|exposed breasts|bare breasts|breasts out|breast exposure|exposed nipples|visible nipples|nipples|nipple slip|puffy nipples|inverted nipples|erect nipples
exposed genitals|visible genitals|genital exposure|genital focus|genitals|genitalia|pussy|pussies|vagina|vaginas|vulva|vulvae|labia|clitoris|clit
spread pussy|spreading own pussy|spreading another's pussy|presenting own pussy|looking at pussy|pussy peek|pussy focus|spread pussy under clothes|half-spread pussy
pussy juice|pussy juice trail|pussy juice on fingers|pussy juice stain|pussy juice puddle|excessive pussy juice|pussy juice on face|pussy juice in mouth
long labia|dark labia|between labia|labia piercing|erect clitoris|large clitoris|clitoris piercing|clitoris ring|clitoral stimulation
penis|penises|dick|cock|phallus|testicles|testicle|scrotum|foreskin|glans|erection|erect penis|erection under clothes|erection in panties
large penis|huge penis|small penis|girthy penis|veiny penis|disembodied penis|penis out|looking at penis|penis peek|twitching penis|penis on face|grabbing another's penis
animal penis|horse penis|knotted penis|gigantic penis|dark penis|penis size difference|multiple penises|penis focus|hand on own penis|hands on penis|licking penis|kissing penis
large testicles|huge testicles|squeezing testicles|caressing testicles|anus|spread anus|spreading own anus|spreading another's anus|presenting own anus|anus peek|puckered anus
sex|sexual intercourse|intercourse|having sex|sexual activity|sex act|coitus|copulation|vaginal sex|vaginal intercourse|vaginal penetration|vaginal
anal sex|anal intercourse|anal penetration|anal|oral sex|oral intercourse|penetrative sex|unprotected sex|public sex|group sex|orgy|gangbang|gang bang
sex from behind|clothed sex|standing sex|after sex|implied sex|tentacle sex|thigh sex|rough sex|stealth sex|happy sex|underwater sex|sex through torn clothes
missionary position|doggystyle|doggy style|doggie style|cowgirl position|reverse cowgirl position|squatting cowgirl position|standing missionary|piledriver (sex)
double penetration|triple penetration|multiple penetration|deep penetration|imminent penetration|cervical penetration|guided penetration|penetration through clothes
double vaginal|double anal|after vaginal|after anal|imminent anal|imminent vaginal|vaginal object insertion|anal object insertion|vaginal fingering|anal fingering
blowjob|blow job|giving head|fellatio|fellation|autofellatio|deepthroat|deep throat|irrumatio|facefuck|face fucking
cunnilingus|cunnilingus through clothes|standing cunnilingus|after cunnilingus|anilingus|rimming|rimjob|rim job
after fellatio|imminent fellatio|cooperative fellatio|cleanup fellatio|standing fellatio|covered fellatio|multiple penis fellatio|implied fellatio
handjob|hand job|double handjob|gloved handjob|two-handed handjob|cooperative handjob|milking handjob|handjob over clothes|handjob under clothes|mutual handjob
footjob|foot job|two-footed footjob|footjob with legwear|cooperative footjob|paizuri|titfuck|titjob|titty fuck|breast sex|paizuri under clothes|cooperative paizuri
tribadism|frottage|frotting|intercrural sex|masturbation|masturbating|female masturbation|male masturbation|mutual masturbation|group masturbation|assisted masturbation
public masturbation|masturbation under clothes|masturbation through clothes|implied masturbation|after masturbation|fingering|fingering through clothes|mutual fingering
fisting|anal fisting|vaginal fisting|finger fucking|nipple stimulation|nipple torture|licking nipple|breast sucking|tweaking own nipple
grabbing another's breast|breast grab|boob grab|breasts grab|grabbing breasts|breast fondling|fondling breasts|fondling penis
nipple tweak|nipple pinch|nipple sucking|nipple suck|breast suck|sucking breasts|sucking nipples
cum|cumshot|cum shot|internal cumshot|creampie|creampied|bukkake|semen|ejaculation|ejaculating|female ejaculation|premature ejaculation|handsfree ejaculation
cum in pussy|cum in mouth|cum on breasts|cum on body|cum in ass|cum on tongue|cum on face|facial cumshot|cum on clothes|cum on hair|cum on stomach|cum on penis
cum on ass|cum on pussy|cum on legs|cum on back|cum on chest|cum on fingers|cum on feet|cum on hands|cum in throat|cum in panties|cum on lips|cum on self
cum overflow|cum string|cum pool|cumdrip|cumdrip from penis|excessive cum|after ejaculation|cum inflation|licking cum|orgasm|orgasming|female orgasm|male orgasm
mutual orgasm|forced orgasm|orgasm denial|ruined orgasm|post orgasm torture|rape|after rape|imminent rape|sexual assault|nonconsensual sex|non-consensual sex
sex toy|sex toys|sex tool|sex machine|sex doll|dildo|double dildo|dildo riding|dildo gag|strap-on dildo|strapless dildo|dildo under clothes|dildo under panties
vibrator|egg vibrator|remote control vibrator|vibrator in anus|vibrator on clitoris|vibrator on penis|vibrator under panties|butt plug|buttplug|anal plug|anal beads
artificial vagina|onahole|fleshlight|cock ring|penis ring|prostate massager|used condom on penis|condom on penis|bdsm|sexual bondage|genital torture|cock and ball torture
naked apron|naked ribbon|naked shirt|naked jacket|naked sweater|naked sheet|naked towel|naked coat|naked hoodie|naked overalls|naked suspenders|naked necktie|naked lab coat|naked cardigan|naked kimono|naked robe|naked cape|naked raincoat|nudist|nudism
shibari|shibari over clothes|shibari under clothes|breast bondage|predicament bondage|suspension bondage|bondage mittens|public bondage|self bondage|erotic bondage|sexual restraint|erotic humiliation
femdom|maledom|dominatrix|pet play|puppy play (bdsm)|pony play (bdsm)|erotic asphyxiation|asphyxiophilia|breath play (bdsm)|sexual sadism|sexual masochism
chastity cage|small chastity cage|flat chastity cage|tube chastity cage|padlocked chastity cage|nub chastity cage|chastity cage emission|chastity device|male chastity device|forced chastity
ball gag|ring gag|nipple clamps|nipple leash|clitoris clamp|labia clamps|anal hook|ball stretcher|urethral beads|urethral sound|urethral sounding
urethral insertion|urethral penetration|implied urethral insertion|urethral fingering|prostate milking|prostate stimulation|prostate massage (sexual)|pegging|imminent pegging|strap-on penetration
foot worship|ass worship|genital worship|cock worship|foot fetish|foot fetishism|boot fetish|latex fetish|latex fetishism|stocking fetish|underwear fetish|armpit fetish|navel fetish
urophilia|urolagnia|urine fetish|watersports (fetish)|coprophilia|scat fetish|lactation fetish|lactophilia|forced lactation|erotic lactation|enema fetish|klismaphilia
tentacle masturbation|tentaclejob|tentacle dildo|penis tentacle|pussy tentacle|tentacle on penis|tentacle penetration|oviposition (sex)|anal vore|vore fetish|inflation fetish|cumflation
nipple object insertion|foreskin insertion|testicle sucking|bound testicles|small penis humiliation|penis under clothes|erotic electrostimulation|genital electrostimulation|sexual edging|orgasm control|forced cunnilingus
露出癖|露陰癖|露阴癖|足交癖|恋足癖|戀足癖|恋靴癖|戀靴癖|乳头夹|乳頭夾|贞操笼|貞操籠|尿道插入|高潮控制|強制高潮|强制高潮|性窒息|触手性交|觸手性交
色情|色情内容|色情內容|成人色情|成人向色情|限制级色情|裸体|裸體|全裸|赤裸全身|露出性器|露出阴部|露出陰部|性器官|生殖器|露阴|露陰
阴茎|陰莖|阴道|陰道|阴部|陰部|外阴|外陰|阴唇|陰唇|阴蒂|陰蒂|睾丸|阴囊|陰囊|龟头|龜頭|勃起|裸乳|露乳|乳头露出|乳頭露出
性交|性爱|性愛|性行为|性行為|做爱|做愛|口交|肛交|阴道性交|陰道性交|群交|轮奸|輪姦|强奸|強姦|强制性交|自慰|手淫|打飞机|打飛機
射精|内射|內射|颜射|顏射|口内射精|口內射精|精液|性高潮|乳交|足交|手交|舌交|舔阴|舔陰|舔肛|指交|拳交|肛塞|自慰棒|假阳具|假陽具|性玩具|鸡巴|雞巴|肉棒|小穴|淫水
全裸女性|全裸男性|膣内射精|フェラチオ|パイズリ|アナルセックス|セックス|オナニー|クンニ|潮吹き|中出し|顔射|口内射精
`.trim().split(/[|\n]/));

const spaced = (text) => text.replace(/[-‐‑–—]+/g, ' ').replace(/\s+/g, ' ').trim();
const canonical = new Map([...explicitTags].map(term => [spaced(term), term]));
const escapePattern = (term) => term.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
// Prefer the longest term at a given position. English terms need word edges;
// Chinese and Japanese tags can appear directly next to surrounding characters.
const terms = [...canonical.keys()].sort((a, b) => b.length - a.length);
const alternatives = (list) => list.map(escapePattern).join('|');
const latin = terms.filter(term => /^[a-z0-9]/.test(term));
const cjk = terms.filter(term => !/^[a-z0-9]/.test(term));
// Some taggers concatenate modifiers ("micropenis", "nakedbody"). Only use
// unbounded stems for distinctive terms; "sex" inside "Essex" isn't a tag.
const joinedStems = ['penis', 'clitoris', 'dildo', 'masturbation', 'blowjob', 'handjob',
  'footjob', 'cumshot', 'paizuri', 'bukkake', 'hentai', 'creampie'];
const contained = new RegExp([
  '(?<![a-z0-9])(?:' + alternatives(latin) + ')(?![a-z0-9])',
  '(?<![a-z0-9])naked',
  alternatives(joinedStems),
  alternatives(cjk),
].join('|'), 'gu');

// Remove only the neutral phrase: another explicit term in the same tag still counts.
const neutralPhrase = /\b(?:naked (?:eye|mole rat|choke)|nude (?:lipstick|makeup|palette|shade|colou?r|heels?|shoes?|stockings|tights)|pussy (?:willow|bow)|moby dick|dick (?:grayson|tracy|dastardly)|cock (?:robin|sparrow)|(?:mixed|same|opposite|single) sex|sex (?:education|ed|symbol|differences?|determination|chromosomes?|ratio)|nsfw (?:artist|filter|warning)|explicit (?:instructions?|permission|consent)|anal retentive)\b/gu;
const discussion = /\b(?:educational|discuss(?:es|ing)?|talking about|warning against)\b/u;
const negativeLead = /(?:\b(?:no|not|non|never|without|neither|nor|avoid(?:s|ing)?|exclud(?:e|es|ing|ed)|forbidden|prohibited|free of|absence of)|n't)\s+(?:(?:any|more|clearly|visible|exposed|explicit|showing|depicting|depictions? of|signs? of|performing|engaging in|wearing)\s+)*$|(?:没有|沒有|无|無|不含|禁止|避免)(?:任何|明显|明顯|暴露|露出|描写|描寫|描绘|描繪|\s)*$/u;

function checkContained(tag, matches) {
  if (/^(?:artist|character|copyright|series)\s*:/.test(tag)) return;
  const text = spaced(tag.replace(/!macro:[^!]*!/g, ' ')).replace(neutralPhrase, ' ');
  for (const clause of text.split(/[.!?。！？]|\b(?:but|however)\b|但是|但有/u)) {
    let negatedEnd = -1;
    for (const hit of clause.matchAll(contained)) {
      const prefix = clause.slice(0, hit.index);
      const joinedNegation = negatedEnd >= 0 && /^\s*(?:or|and|或|和|与|與)\s*$/u.test(prefix.slice(negatedEnd));
      if (joinedNegation || negativeLead.test(prefix) || discussion.test(prefix)) {
        negatedEnd = hit.index + hit[0].length;
      } else {
        matches.add(canonical.get(hit[0]));
      }
    }
  }
}

function checkTags(text, matches) {
  for (let tag of text.split(/[,、;|\n\r]+/)) {
    tag = tag.replace(/[{}\[\]]/g, '').trim()
      .replace(/^(?:character\s*\d+|角色\s*\d+)\s*:\s*/, '')
      .replace(/^(?:source|target|mutual)#\s*/, '')
      .replace(/[_\s]+/g, ' ').replace(/[’‘]/g, "'").trim();

    // Accept parenthesized prompt weights and preserve qualifiers in the tag
    // itself (for example, "piledriver (sex)").
    const weighted = /^\((.+):\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\)$/.exec(tag);
    if (weighted) {
      if (Number(weighted[2]) <= 0) continue;
      tag = weighted[1].trim();
    }
    tag = tag.replace(/^\(+/, '');
    if (!tag.includes('(')) tag = tag.replace(/\)+$/, '');
    tag = tag.replace(/^rating(?:\s*:\s*|\s+)/, 'rating:').trim();
    if (explicitTags.has(tag)) matches.add(tag);
    else checkContained(tag, matches);
  }
}

function checkCaption(text, matches) {
  if (typeof text !== 'string' || !text) return;
  const groups = text.normalize('NFKC').toLowerCase().split('::');
  let insideWeight = false, suppressed = false;
  for (const [index, group] of groups.entries()) {
    // Read the sign once for the entire NAI weight group, including comma-
    // separated terms. Digits at the end of a tag inside it are just text.
    const weight = !insideWeight && index < groups.length - 1 &&
      /[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/.exec(group);
    if (!suppressed) checkTags(weight ? group.slice(0, weight.index) : group, matches);
    insideWeight = Boolean(weight);
    suppressed = insideWeight && Number(weight[0]) <= 0;
  }
}

export function classifyWorkNSFW(work) {
  const matches = new Set();
  checkCaption(work?.prompt, matches);
  const characters = work?.settings?.characters;
  for (const character of Array.isArray(characters) ? characters : []) {
    if (character?.enabled !== false) checkCaption(character?.prompt, matches);
  }
  // Pixel edits can have an empty caption. Carry only known tags recorded
  // from their source. An ordinary generation with a new prompt starts fresh.
  const mode = work?.mode || work?.settings?.mode;
  if ((mode === 'upscale' || mode === 'augment') && Array.isArray(work.sourceNsfwTags)) {
    for (const tag of work.sourceNsfwTags) if (explicitTags.has(tag)) matches.add(tag);
  }
  return { nsfw: matches.size > 0, matches: [...matches] };
}
