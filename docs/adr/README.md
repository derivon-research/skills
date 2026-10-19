# Architecture Decision Records

Decisions about authoring methodology. Product semantics and protocols are decided in
`derivon-research/derivon-mindmap` (`docs/adr/README.md`), which also carries the rules for
writing and changing an ADR.

## Index

Read this table, then the one to three ADRs it points at. Never all of them.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-model-derivations-as-problem-led-responses.md) | Every derivation is a response to concrete problem pressure; its document owns the problem-to-resolution account | accepted |
| [0002](0002-separate-explored-knowledge-from-mastery.md) | Graph membership records explored knowledge; mastery evidence is kept separate from it | accepted |

A new ADR gets its index row in the same change; `npm test` fails otherwise.
