# Spec: tail-view, vylepšení 1–11

## Kontext

tail-view 0.2.0 (repo `MartinSzollos2016/my-claude-tui`) je v review v adresáři Anthropic. Z rešerše vznikl backlog. Tento spec pokrývá body **1–11**: robustnost a technický dluh (1–6) a paritu s tail-claude (7–11). Body 12–18 (limity plánu, sparkline, hotspoty, churn, diff renderer, spinner, vnořené subagenty) a 19–21 (userConfig, CHANGELOG/release, GIF) jsou **mimo rozsah**.

**Společná omezení pro všechny body**

- Žádné spouštění programů a žádná síť: nesmí přibýt nové policy holds v adresáři. Povolené jsou jen volání `$.session`, `$.agent`, `$.ui`, `$.state`, `$.store`, `$.clock`, `$.config.list` a `$.fs` (čtení).
- Pravidla validátoru adresáře: `$` se předává jen přímo do funkcí deklarovaných na nejvyšší úrovni souboru, nikdy uvnitř argumentu jiného volání. Neplatí žádné jméno `h`/`Fragment`. Práce na pozadí končí `.catch(ignore)`.
- Barvy jen přes klíče motivu (`ThemeKey`). Text projde `sanitizeText`. Bloky textu musí dodržet limity enginu (8k na kus, rozpočet panelu 70k).
- TDD: čistá logika ve Vitestu (coverage prahy zůstávají), wiring přes `claude plugin test`.
- Po implementaci musí projít `npm run check`, `npm run coverage` a `scripts/smoke-install.sh`. Commity po částech, gitmoji + Conventional Commits.

---

## 1. Memoizace tahů a trací

**Problém:** `ui.render` pro Pane volá při každém ticku (500 ms) `$.session.messages()` (až 4096 řádků), `buildTurns` nad celou historií a `loadTraces` pro všechny rozbalené subagenty.

**Návrh**

- `hooks/model.ts`: čistá funkce `turnsKey(messages)`, otisk z délky, posledního `tool_use_id` a délky textu poslední zprávy. Modulová cache `{ key, turns }` v `register.tsx` přepočítá `buildTurns` jen při změně otisku.
- Trace subagentu se cachuje podle `agentId` a otisku jeho zpráv. Dokončený agent (status `completed` / `failed` / `killed`) se cachuje natrvalo, běžící se znovu načte jen jednou za tick.
- Cache je modulová, při reloadu se zahodí, a to je v pořádku.

**Testy:** `turnsKey` se mění při nové zprávě, nové odpovědi nástroje i doplněném textu a nemění se, když se nic nestalo. Engine test: dva rendery bez změny zpráv postaví tahy jen jednou (ověří se počítadlem přes hook na `session.messages`).
**Přijetí:** stejný výstup jako dnes. Při nezměněné session se `buildTurns` nevolá opakovaně.

## 2. Statistiky tahů podle `turnId`

**Problém:** `statFor` páruje podle textu promptu, takže dva stejné prompty dostanou cizí čas a tokeny.

**Návrh**

- Hook `turn.start` (jen hlavní smyčka, bez `agentId`): uloží `turnId → index tahu`. Index je poslední tah v `buildTurns(messages)` v tu chvíli.
- `turn.complete` zapíše stat s `turnIndex` místo s textem promptu. `TurnStat` dostane pole `turnIndex: number` a `prompt` zůstane jen pro zobrazení.
- `statFor(stats, index)` hledá podle indexu. Pro staré staty bez indexu zůstává záložní párování podle textu.

**Testy:** dva stejné prompty dostanou každý svůj stat. Stat bez indexu se dál páruje podle textu.
**Přijetí:** hlavička i seznam tahů ukazují správný čas a tokeny i u opakovaných promptů.

## 3. Ověření motivů „Tail …“

**Návrh**

- `tailThemeAdvice(current, options)`: z `options` řádku motivu v `config.list` pozná, jestli jsou `custom:tail-view:*` k dispozici.
  - Pokud ano: dnešní rada.
  - Pokud ne: „Tail themes are not loaded in this session; run /reload-plugins or reinstall tail-view.“
- Ruční ověření: v nainstalovaném pluginu otevřít `/theme`. Když se varianty neobjeví ani po reloadu, `themes/` a `/tail-theme` se odeberou samostatným commitem a README se upraví.

**Testy:** rada pro dostupné a nedostupné varianty.
**Přijetí:** `/tail-theme` říká pravdu o tom, jestli varianty jdou vybrat.

## 4. Testovatelný `register.tsx`

**Návrh:** logika hooků se přesune do čistých funkcí v novém `hooks/session.ts`, `register.tsx` zůstane tenké napojení:

- `recordToolStart(timings, id, now)` a `recordToolEnd(timings, id, now)` (včetně ořezu na `MAX_TIMINGS`),
- `turnStatFrom(input, prompt, now, index)`,
- `nextSelectedTurn(cur, latest, delta)` (dnes lokální `setTurn`),
- `toggleId(ids, id, max)` (opakuje se 3×).

**Testy:** Vitest pro všechny funkce. Coverage `register.tsx` a `session.ts` dohromady nad 60 %, `session.ts` 98 %. Prahy ve `vitest.config.ts` se zpřísní.
**Přijetí:** stejné chování, vyšší coverage, žádná duplicitní logika.

## 5. Fallback pro povrchy bez kreslení

**Problém:** ve VS Code a v `claude -p` se pane nevykreslí a `/tail` tam nic nedělá.

**Návrh**

- `runCommand` zjistí povrch přes `$.session.surface()`.
- Na `vscode` nebo bez povrchu (`null`) vrátí `/tail` a `/tail-turns` text místo otevření panelu.
  - `/tail`: hlavička tahu a řádky položek. Pomůže čistá funkce `turnText(turn, stats)` v `model.ts`, která přepoužije `itemName`, `itemSummary` a `formatDuration`. Délka je omezená přes `clampText`.
  - `/tail-turns`: seznam tahů jako text.

**Testy:** `turnText` (Vitest). Engine test: `/tail` při povrchu `vscode` vrátí text a neotevře pane.
**Přijetí:** ve VS Code dává `/tail` užitečný textový výstup.

## 6. CI údržba

**Návrh**

- `runs-on: ubuntu-24.04` v obou jobech.
- `.github/dependabot.yml`: `github-actions` (týdně, aktualizuje SHA i s komentářem verze), `npm` pro kořen (týdně, seskupené dev závislosti) a `npm` pro `.github/tools` (Claude Code verze, měsíčně).
- Ověření přes actionlint a zizmor (bez nálezů) a `act`.

**Přijetí:** CI zelené, Dependabot konfigurace validní (GitHub ji zobrazí v Insights → Dependency graph).

## 7. Hledání v tazích

**Návrh**

- V pohledu „Turns“ přibude `Input` (`key: 'turn-search'`, placeholder „Search turns“).
  - `onInput` uloží dotaz do stavu (`tail-view.query`, kontrakt v `types/index.d.ts`).
  - `onSubmit` otevře první shodu.
- Čistá funkce `searchTurns(turns, query)` v `model.ts`:
  - hledá bez ohledu na velikost písmen v promptu, výstupech, souhrnech a výsledcích nástrojů (už sanitizovaných),
  - vrací indexy tahů a úryvek kolem první shody (max 80 znaků).
- Seznam ukazuje jen shody: počet a u řádku úryvek. Esc nebo prázdný dotaz vrátí celý seznam.
- Klávesa `/` v pane fokusuje pole, přes `Button` s `hotkey` a `$.ui.focus`.

**Testy:** `searchTurns` (Vitest: case-insensitive, úryvek, prázdný dotaz, dlouhý vstup lineárně). View test: řádky se filtrují. Engine test: zadání textu přes `ui.input` zúží seznam.
**Přijetí:** v session s desítkami tahů najde tah podle slova z promptu nebo výstupu.

## 8. Thinking

**Návrh**

- Čistá funkce `thinkingCounts(apiMessages)` počítá bloky `thinking` / `redacted_thinking` na tah. Tahy seskupuje stejně jako `buildTurns`: tah otevírá uživatelská zpráva s textem, ne výsledkem nástroje.
- Data se čtou přes `$.session.messages({ as: 'api' })`, jen pro zobrazený tah (cache jako v bodě 1). Počty se s tahy párují od konce, protože obě řady končí posledním tahem.
- Hlavička: ikona thinking s počtem, jako v tail-claude. Pokud thinking blok nese text, přibude řádek „Thinking“ s rozbalením (Markdown, náhled jako u výstupu).

**Testy:** `thinkingCounts` (prázdné bloky, redacted, více tahů). View test hlavičky.
**Přijetí:** hlavička ukáže počet thinking bloků i u modelů s prázdným textem.

## 9. Workflow badge a řádek

**Návrh**

- Řádek nástroje `Workflow`: souhrn už existuje (`toolSummary`). Přibude stav běží nebo hotovo (pending podle `isPending`) a spinner.
- Info bar: badge „workflow running“ (barva `success`), když poslední tah obsahuje nedokončený `Workflow`. Počet agentů je best-effort: unikátní `agentId` z `tool.call` a `turn.complete`, která `$.agent.list()` nezná, počítané od startu workflow. Bez dat jen „workflow running“.

**Testy:** čistá funkce `workflowState(turn, unknownAgents)` (Vitest). View test badge.
**Přijetí:** při běžícím Workflow je badge vidět a po dokončení zmizí.

## 10. Týmový board

**Návrh**

- Nový pohled pane `team` (klávesa `m`, tlačítko „team“ v navigaci jen pokud existují teammates nebo úkoly).
- Členové: `$.agent.list()` s `teammateId`, se jménem, typem a stavem (barva podle stavu).
- Úkoly: čistá funkce `taskBoard(turns)` z volání `TaskCreate` / `TaskUpdate` (subject, status, owner). Poslední stav úkolu vyhrává. Ikony ☐ / ◐ / ☑ jako u TodoWrite.

**Testy:** `taskBoard` (Vitest: vytvoření, přeřazení, dokončení). View test pohledu `team`.
**Přijetí:** v týmové session pane ukáže členy a stav úkolů. V běžné session se tlačítko „team“ nezobrazí.

## 11. Kopírování

**Návrh**

- V hlavičce každého rámečku sekce přibude tlačítko „copy“ (`key: copy:<blockId>`). Zkopíruje celé tělo sekce (příkaz, diff, výstup), ne jen náhled, přes `$.ui.copy({ text })`.
- Výsledek se ukáže přes `$.ui.toast`: „Copied“, nebo důvod při `isCopied: false`.
- Tlačítko volá top-level funkci `copyBlock($, text)`, kvůli pravidlům validátoru.

**Testy:** view test (tlačítko u každé sekce). Engine test: stisk zavolá `ui.copy` s plným textem (hook na `ui.copy` v testu).
**Přijetí:** příkaz i výstup jdou zkopírovat jedním klikem a schránka obsahuje celý text.

---

## Pořadí implementace

`6 → 4 → 1 → 2 → 11 → 5 → 3 → 7 → 8 → 9 → 10`. Nejdřív infrastruktura a refaktor, na které ostatní body stojí, pak funkce od nejmenší po největší. Po schválení spec uložím do `docs/specs/2026-10-04-tail-view-1-11-design.md`, commitnu ho a přes `superpowers:writing-plans` z něj udělám implementační plán po úlohách.

## Ověření (celek)

1. `npm run check`, `npm run coverage` (zpřísněné prahy), `scripts/smoke-install.sh`.
2. `act` z čistého klonu a zelené CI na GitHubu.
3. Validace v portálu adresáře: žádné nové blokující nálezy ani policy holds.
4. Ruční ověření v Claude Code: hledání, kopírování, thinking, workflow badge, `/tail` ve VS Code (pokud je k dispozici).
