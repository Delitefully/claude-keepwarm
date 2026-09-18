#!/bin/bash
# Blanks the one-character answer the keepalive ping produces, so an idle session
# doesn't accumulate a column of stray periods. Display-only: the transcript and
# what Claude sees are unchanged.
#
# Runs on every streamed batch of every assistant message, so it stays pure bash
# with no interpreter start-up and no JSON parser.
input=$(cat)
case "$input" in
  *'"delta":"."'*|*'"delta":".\n"'*)
    printf '{"hookSpecificOutput":{"hookEventName":"MessageDisplay","displayContent":""}}' ;;
  *)
    printf '{}' ;;
esac
