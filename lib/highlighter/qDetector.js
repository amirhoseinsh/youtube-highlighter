const Q_REGEX =
  /\b(what|why|how|where|when|who|which|can|could|should|would|do|does|did|is|are|will)\b.*\?*$/i;

export function markQuestions(sentences) {
  return sentences.map((sent) => ({
    ...sent,
    isQ:
      Q_REGEX.test(sent.text.toLowerCase()) ||
      sent.text.toLowerCase().startsWith("i have a question"),
  }));
}
