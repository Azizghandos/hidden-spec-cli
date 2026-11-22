# mend

One patch tool for every AI edit format.

`mend` applies an edit that an AI model wrote to a tree of text files.
Models write edits in four formats, and `mend` reads them all: unified
diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches,
and text-editor tool calls as JSON. Every file is changed or nothing is:
a failed edit changes nothing, later edits still run, and when any edit
fails no file is written at all.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or `-`/absent to read the patch from standard
input. `--format` picks one format (`unified`, `search-replace`, `v4a`,
`json`); the default `auto` detects it. `--check` reports what would
change without writing anything. `--strict` matches lines exactly.

Node 22, standard library only. See `SPEC.md` for the full contract.
