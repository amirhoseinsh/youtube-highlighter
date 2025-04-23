#!/usr/bin/env python3
import os, sys
from transformers import pipeline, AutoTokenizer

# optional: silence the HF symlink warning
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

# use the smaller Text2Text model
model_name = "pszemraj/grammar-synthesis-small"
tokenizer = AutoTokenizer.from_pretrained(model_name)
model     = pipeline(
    "text2text-generation",
    model=model_name,
    device="cpu",
)

MAX_TOKENS = tokenizer.model_max_length  # usually 512

for line in sys.stdin:
    text = line.strip()
    if not text:
        print()  # preserve empty lines
        continue

    # 1) tokenize & truncate to 512
    ids = tokenizer.encode(text, truncation=False)
    if len(ids) > MAX_TOKENS:
        ids = ids[:MAX_TOKENS]
        # decode back to a shorter string
        text = tokenizer.decode(ids, skip_special_tokens=True)

    # 2) generate with safe lengths
    word_count = len(text.split())
    max_len   = max(word_count * 2, 5)  # at least 5 tokens out
    out = model(
        text,
        max_length=max_len,
        min_length=1,
        do_sample=False,
        truncation=True,     # extra guard
    )

    print(out[0]["generated_text"], flush=True)
