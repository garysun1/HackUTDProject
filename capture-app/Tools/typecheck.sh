#!/bin/zsh
# Type-checks Shift Memory source files against the iOS Simulator SDK without opening Xcode.
# Usage: Tools/typecheck.sh [--tests] <file.swift> ...
# The app's shared contracts are always included. With --tests, XCTest is made importable and
# `@testable import ShiftMemory` lines are stripped (everything compiles as one module here).
set -euo pipefail
setopt null_glob
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
PLATFORM="$(xcrun --sdk iphonesimulator --show-sdk-platform-path)"
TESTS=0
if [[ "${1:-}" == "--tests" ]]; then TESTS=1; shift; fi
CONTRACTS=(
  "$HERE/ShiftMemory/Upload/CaptureEvent.swift"
  "$HERE/ShiftMemory/Upload/EventEnvelope.swift"
  "$HERE/ShiftMemory/Upload/IngestContracts.swift"
  "$HERE/ShiftMemory/Upload/LocationFix.swift"
  "$HERE/ShiftMemory/Upload/TrackJSONText.swift"
  "$HERE/ShiftMemory/Pipeline/PipelineContracts.swift"
  "$HERE/ShiftMemory/Diagnostics/DiagnosticsModels.swift"
  "$HERE/ShiftMemory/Import/ImportContracts.swift"
  "$HERE/ShiftMemory/UI/Theme.swift"
)
FILES=()
TMP="$(mktemp -d)"
for f in "$@"; do
  case " ${CONTRACTS[*]} " in *" $(cd "$(dirname "$f")" && pwd)/$(basename "$f") "*) continue;; esac
  if [[ $TESTS -eq 1 ]]; then
    cp "$f" "$TMP/$(basename "$f")"
    sed -i '' -e 's/^@testable import ShiftMemory$//' -e 's/^import ShiftMemory$//' "$TMP/$(basename "$f")"
    FILES+=("$TMP/$(basename "$f")")
  else
    FILES+=("$f")
  fi
done
EXTRA=()
# DAT frameworks from the most recent simulator build, so files importing MWDAT* can be checked too.
for d in "$HERE/../.." /private/tmp/claude-501/-Users-edwardkim/*/scratchpad "$HOME/Library/Developer/Xcode/DerivedData"/ShiftMemory-*; do
  for f in "$d"/DerivedData/Build/Products/Debug-iphonesimulator "$d"/Build/Products/Debug-iphonesimulator; do
    if [[ -d "$f/MWDATCore.framework" ]]; then EXTRA+=(-F "$f"); break 2; fi
  done
done
if [[ $TESTS -eq 1 ]]; then EXTRA+=(-F "$PLATFORM/Developer/Library/Frameworks" -I "$PLATFORM/Developer/usr/lib"); fi
xcrun swiftc -typecheck \
  -module-name ShiftMemory \
  -swift-version 6 \
  -enable-upcoming-feature NonisolatedNonsendingByDefault \
  -sdk "$SDK" -target arm64-apple-ios17.2-simulator \
  -D DEBUG \
  "${EXTRA[@]}" \
  "${CONTRACTS[@]}" "${FILES[@]}"
echo "typecheck OK: ${#FILES[@]} file(s) + contracts"
