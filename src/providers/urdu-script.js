// Grok's speech-to-text sometimes writes spoken Urdu in Hindi (Devanagari) letters.
// Copied from agenticcore-estate services/telegram/voice.mjs: letters are converted
// one by one into Urdu script. Text without Devanagari is returned unchanged.
const DV_CONS = {
  'क': 'ک', 'ख': 'کھ', 'ग': 'گ', 'घ': 'گھ', 'ङ': 'ن', 'च': 'چ', 'छ': 'چھ', 'ज': 'ج', 'झ': 'جھ', 'ञ': 'ن',
  'ट': 'ٹ', 'ठ': 'ٹھ', 'ड': 'ڈ', 'ढ': 'ڈھ', 'ण': 'ن', 'त': 'ت', 'थ': 'تھ', 'द': 'د', 'ध': 'دھ', 'न': 'ن',
  'प': 'پ', 'फ': 'پھ', 'ब': 'ب', 'भ': 'بھ', 'म': 'م', 'य': 'ی', 'र': 'ر', 'ल': 'ل', 'व': 'و', 'श': 'ش',
  'ष': 'ش', 'स': 'س', 'ह': 'ہ', 'क़': 'ق', 'ख़': 'خ', 'ग़': 'غ', 'ज़': 'ز', 'फ़': 'ف', 'ड़': 'ڑ', 'ढ़': 'ڑھ', 'य़': 'ی'
};
const DV_NUKTA = { 'क': 'ق', 'ख': 'خ', 'ग': 'غ', 'ज': 'ز', 'फ': 'ف', 'ड': 'ڑ', 'ढ': 'ڑھ', 'य': 'ی' };
// property words and abbreviations spelt the way Urdu writes them
const DV_WORDS = { 'डीएचए': 'DHA', 'डी एच ए': 'DHA', 'सीडीए': 'CDA', 'एलडीए': 'LDA', 'फेज़': 'فیز', 'फेज': 'فیز', 'फेस': 'فیز', 'मरला': 'مرلہ', 'मरले': 'مرلے', 'कनाल': 'کنال', 'करोड़': 'کروڑ', 'करोड': 'کروڑ', 'लाख': 'لاکھ', 'हज़ार': 'ہزار', 'हजार': 'ہزار', 'प्लॉट': 'پلاٹ', 'प्लाट': 'پلاٹ', 'फ्लैट': 'فلیٹ', 'वेबसाइट': 'ویب سائٹ', 'टाउन': 'ٹاؤن', 'सेक्टर': 'سیکٹر' };
const DV_START = { 'अ': 'ا', 'आ': 'آ', 'इ': 'ا', 'ई': 'ای', 'उ': 'ا', 'ऊ': 'او', 'ए': 'اے', 'ऐ': 'اے', 'ओ': 'او', 'औ': 'او', 'ऋ': 'ر' };
const DV_AFTER_VOWEL = { 'अ': 'ا', 'आ': 'آ', 'इ': 'ئ', 'ई': 'ئی', 'उ': 'ؤ', 'ऊ': 'ؤ', 'ए': 'ئے', 'ऐ': 'ئے', 'ओ': 'و', 'औ': 'و', 'ऋ': 'ر' };
const DV_SIGN = { 'ा': 'ا', 'ि': '', 'ी': 'ی', 'ु': '', 'ू': 'و', 'ो': 'و', 'ौ': 'و', 'ृ': 'ر', '्': '', 'ः': 'ہ', 'ॅ': 'ے', 'ॉ': 'ا' };
const DV_PRE = { '\u0958': 'ق', '\u0959': 'خ', '\u095A': 'غ', '\u095B': 'ز', '\u095C': 'ڑ', '\u095D': 'ڑھ', '\u095E': 'ف', '\u095F': 'ی' };
const isDv = (c) => c >= '\u0900' && c <= '\u097F';
const isLetter = (c) => isDv(c) && c !== '।' && c !== '॥' && !(c >= '०' && c <= '९');

export function devanagariToUrdu(text) {
  const s = String(text || '').normalize('NFC');
  if (!/[\u0900-\u097F]/.test(s)) return s;
  let w = s;
  for (const k of Object.keys(DV_WORDS).sort((x, y) => y.length - x.length)) {
    w = w.replace(new RegExp('(^|[^\\u0900-\\u097F])' + k.normalize('NFC') + '(?![\\u0900-\\u097F])', 'g'), (m, pre) => pre + DV_WORDS[k]);
  }
  const chars = Array.from(w);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i], prev = chars[i - 1], next = chars[i + 1];
    const wordEnd = !next || !isLetter(next);
    if (DV_CONS[c] && next === '\u093C') { out += DV_NUKTA[c] || DV_CONS[c]; i++; }
    else if (DV_CONS[c]) out += DV_CONS[c];
    else if (DV_PRE[c]) out += DV_PRE[c];
    else if (c === 'े' || c === 'ै') out += wordEnd ? 'ے' : 'ی';
    else if (c in DV_SIGN) out += DV_SIGN[c];
    else if (c === 'ं' || c === 'ँ') out += (!next || !isLetter(next)) ? 'ں' : 'ن';
    else if (DV_START[c]) out += (prev && isLetter(prev) && !DV_CONS[prev]) || (prev && DV_SIGN[prev] !== undefined && prev !== '्') ? DV_AFTER_VOWEL[c] : DV_START[c];
    else if (c === '।' || c === '॥') out += '۔';
    else if (c >= '०' && c <= '९') out += String(c.charCodeAt(0) - 0x0966);
    else if (isDv(c)) out += '';
    else out += c;
  }
  return out;
}
