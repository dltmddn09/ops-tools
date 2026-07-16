# 패치노트 변환기 - 상세 로직 문서

## 1. 전체 구조

단일 HTML 파일 (`index.html`). 두 개의 메인 탭으로 구성:
- **웹어드민 변환**: 패치노트 → 어드민툴 HTML 코드
- **스팀 변환**: 패치노트 → Steam BBCode

각 탭은 다국어 일괄 변환 / 단일 언어 변환 서브탭으로 나뉨.

---

## 2. 엑셀 컬럼 구조

```
A열(cols[0]): 부호
B열(cols[1]): KR
C열(cols[2]): 구분 → 항상 무시
D열(cols[3]): EN
E열(cols[4]): DE
F열(cols[5]): ES-ES
G열(cols[6]): ES-MX
H열(cols[7]): FR
I열(cols[8]): IT
J열(cols[9]): PL
K열(cols[10]): PT-BR
L열(cols[11]): TR
M��(cols[12]): RU
N열(cols[13]): CN
O열(cols[14]): TW
P열(cols[15]): JP
```

코드 상수:
```javascript
const LANGS = ['KR','EN','DE','ES-ES','ES-MX','FR','IT','PL','PT-BR','TR','RU','CN','TW','JP'];
```

---

## 3. 공통 함수

### getSymbol(line)
줄의 첫 번째 열(부호)을 읽어 심볼 반환. 없으면 `null`.
```javascript
'★' → '★'
'□' → '□'
'◎' → '◎'
'▶' → '▶'
'▷' → '▷'
'◆' → '◆'
'◇' → '◇'
'-' → '-'
'>' → '>'
그 외 → null
```

### getLevel(sym) — 웹어드민 전용
```javascript
'◆' → 1 (메인 항목)
'◇' → 2 (1차 하위)
'-' → 3 (2차 하위)
'>' → 4 (3차 하위)
그 외 → 0
```

### stripQuotes(text) — 웹어드민 전용
텍스트 앞뒤 따옴표(`"`, `"`, `"`) 제거.

### escapeSteam(text) — 스팀 전용
`[`로 시작하는 텍스트를 `\[`로 이스케이프. (스팀 BBCode 태그 충돌 방지)

---

## 4. 웹어드민 변환 로직 (convertLines)

### 부호별 출력 HTML

| 부호 | 출력 HTML |
|------|-----------|
| 없음(null) | `텍스트 <br />` (빈 셀 무시) |
| ★ | `<div></div><div><span style='color: #eed39e;'><strong>텍스트</strong></span></div>` |
| □ | `<div></div><div><span style='color: #eed39e;'><strong><span style='font-size: 20px;'>텍스트</span></strong></span></div><div><hr class='cd_tpl_divider' /></div>` |
| ◎ | `<div> </div><div><span style='color: #eed39e;'><strong><span style='font-size: 20px;'>텍스트</span></strong></span></div>` |
| ▶ | `<details><summary style='cursor: pointer;'>텍스트</summary>` |
| ▷ (마지막) | `<li>텍스트</details>` |
| ▷ (중간) | `<li>텍스트` |

### ◆◇->(레벨 기반) 중첩 리스트 규칙

다음 심볼의 레벨(`nextLevel`)을 보고 태그 열고 닫기 결정:

**◆ (level=1)**
- 다음이 ◇(level=2): `<ul><li>텍스트<ul>` (하위 시작)
- 다음이 ◆ 이하 또는 끝: `<li>텍스트</li>`

**◇ (level=2)**
- 다음이 -(level=3): `<li>텍스트<ul>` (하위 시작, 하위용 `<ul>` 오픈)
- 다음이 ◆ 이하(nextLevel≤1): `<li>텍스트</li></ul></li></ul>` (2단계 닫기)
- 그 외: `<li>텍스트`

**- (level=3)**
- 다음이 >(level=4): `<li>텍스트<ul>` (하위 시작, 하위용 `<ul>` 오픈)
- 다음이 -(level=3): `<li>텍스트`
- 다음이 ◇(level=2): `<li>텍스트</li></ul></li>` (1단계 닫기)
- 다음이 ◆ 이하(nextLevel≤1): `<li>텍스트</li></ul></li></ul></li></ul>` (3단계 닫기)

**> (level=4)**
- 다음이 >(level=4): `<li>텍스트`
- 다음이 -(level=3): `<li>텍스트</li></ul></li>`
- 다음이 ◇(level=2): `<li>텍스트</li></ul></li></ul></li>`
- 다음이 ◆ 이하(nextLevel≤1): `<li>텍스트</li></ul></li></ul></li></ul></li></ul>` (4단계 닫기)

### addDiv 옵션
체크 시 결과 맨 앞에 `<div>\n` 추가.

---

## 5. 스팀 BBCode 변환 로직 (runSteamConvert)

### 부호별 출력 BBCode

**부호 없음 (null) — 연속 묶기**
연속된 null 행들을 while로 모아서 하나의 `[p]`로 묶음:
```
[p]줄1\n줄2\n줄3[/p]
```
앞뒤 따옴표 제거 후 trim.

**플랫폼 필터링 (스팀 전용)**
null 행 묶기 시 아래 플랫폼명으로 시작하는 줄은 출력에서 제외:
- `플레이스테이션`, `PlayStation`, `Xbox`, `Epic Games Store`, `Mac App Store`
- `Steam (PC)`, `Steam (Mac)` 줄만 유지됨
- `: 뒤의 상태` 문구가 바뀌어도 플랫폼명 기준으로 판단
- ⚠️ KR은 `플레이스테이션`, 다른 언어는 `PlayStation`으로 표기되므로 **둘 다 필요**
- ⚠️ 대소문자 무시하고 비교(`toLowerCase()`). 패치마다 `Xbox`/`XBOX` 등 표기가 섞여 들어와서, 대소문자 구분 비교였던 과거 버전은 `XBOX`로 표기된 행을 걸러내지 못해 스팀 결과물에 Xbox 문구가 그대로 노출되는 버그가 있었다 (2026-07-15 수정).

**★**
```
[p][b]텍스트[/b][/p]
```

**◎**
```
[p] [/p][p][b]텍스트[/b][/p]
```

**□**
```
[p] [/p][p][b]텍스트[/b][/p][hr][/hr]
```

**▶ (스포일러 제목)**
```
[list][*][p]텍스트[/p][/*][/list][expand]
```
→ 제목은 [list] 바깥, 내용만 [expand] 안으로.

**▷ (스포일러 내용)**
- 첫 번째, 다음도 ▷: `[list][*][p]텍스트[/p][/*]`
- 첫 번째, 마지막: `[list][*][p]텍스트[/p][/*][/list][/expand]`
- 중간: `[*][p]텍스트[/p][/*]`
- 마지막: `[*][p]텍스트[/p][/*][/list][/expand]`

### ◆ 변환 규칙

**현재 ◆가 하위(◇/-/>) 있음:**
- 이전이 ◆ 이거나 ◇/-/>(하위 그룹이 방금 끝남): 이미 공유 [list]가 열려 있으므로 `[*][p]텍스트[/p]`
- 그 외(문단 직후 등 새로 시작): `[list][*][p]텍스트[/p]`
```
[list][*][p]텍스트[/p]
```
(하위가 끝날 때 ◇/- 쪽에서 닫힘)

> **2026-07-04 수정**: "이전이 ◇/-/>인 경우"가 원래 빠져 있어서, 하위 그룹을 가진 ◆ 바로 뒤에 또 하위를 가진 ◆가 오면(예: "[클리프/웅카]..." 다음에 "[데미안]...") 직전 심볼이 ◆가 아니라 마지막 하위 부호(-/>)가 되어 `prevIsMain`이 false로 오판, 불필요한 [list]를 하나 더 열어버리는 버그가 있었다. 이 [list]는 닫아주는 로직이 없어 이후 모든 최상위 ◆ 항목이 한 단계씩 더 감싸이는 문제로 이어졌다.

**현재 ◆가 하위 없음 — 그룹 첫 번째:**
- 다음이 ◆: `[list][*][p]텍스트[/p][/*]`
- 다음이 ◆ 아님(섹션 끝): `[list][*][p]텍스트[/p][/*][/list]`

**현재 ◆가 하위 없음 — 그룹 중간(이전이 ◆):**
- 다음이 ◆: `[*][p]텍스트[/p][/*]`
- 다음이 ◆ 아님(섹션 끝): `[*][p]텍스트[/p][/*][/list]`

**현재 ◆가 하위 없음 — 하위 끝난 직후(이전이 ◇/-/>):**
- 다음이 ◆: `[*][p]텍스트[/p][/*]`
- 다음이 ◆ 아님: `[*][p]텍스트[/p][/*][/list]`

### ◇ 변환 규칙

**첫 번째 ◇ (이전이 ◇/-/> 아님):**
- 다음이 -(대시): `[list][*][p]텍스트[/p]` (- list가 안에서 열릴 예정)
- 다음이 ◇: `[list][*][p]텍스트[/p][/*]`
- 다음이 독립 ◆(하위 있는 ◆): `[list][*][p]텍스트[/p][/*][/list][/*]`
- 그 외(그룹 ◆ or 끝): `[list][*][p]텍스트[/p][/*][/list][/*]`

**중간/마지막 ◇ (이전이 ◇/-/>):**
- 다음이 -(대시): `[*][p]텍스트[/p]`
- 다음이 ◇: `[*][p]텍스트[/p][/*]`
- 다음이 독립 ◆: `[*][p]텍스트[/p][/*][/list][/*]`
- 그 외: `[*][p]텍스트[/p][/*][/list][/*]`

> **2026-07-04 수정**: "다음이 독립 ◆" 케이스는 원래 `[/*][/list][/*][/list]`(리스트 2개 닫기)였으나, 이는 상위에서 공유 중인 [list](형제 ◆들을 감싸는 리스트)까지 잘못 닫아버리는 버그였다. 독립 ◆도 결국 같은 공유 [list]의 형제이므로 "그 외" 케이스와 동일하게 [list] 1개만 닫아야 정상. (◆ 항목이 재사용 없이 새 [list]를 여는 경우는 없으므로 — 아래 ◆ 규칙 참고 — 항상 공유 리스트가 열려있다고 가정 가능)

### - / > 변환 규칙

**첫 번째 - (이전이 -/> 아님):**
- 다음이 -/>: `[list][*][p]텍스트[/p][/*]`
- 다음이 ◇/-/>: `[list][*][p]텍스트[/p][/*][/list][/*]` (list 닫고 상위 ◇ 닫기)
- 다음이 ◆: `[list][*][p]텍스트[/p][/*][/list][/*][/list][/*]` (외부 ◆ list 유지 — 남은 ◆ 항목들이 같은 그룹)
- 끝: `[list][*][p]텍스트[/p][/*][/list][/*][/list][/*][/list]` (3단계 닫기)

**중간/마지막 - (이전이 -/>):**
- 다음이 -/>: `[*][p]텍스트[/p][/*]`
- 다음이 ◇/-/>: `[*][p]텍스트[/p][/*][/list][/*]`
- 다음이 ◆: `[*][p]텍스트[/p][/*][/list][/*][/list][/*]` (외부 ◆ list 유지)
- 끝: `[*][p]텍스트[/p][/*][/list][/*][/list][/*][/list]`

---

## 6. 다국어 일괄 변환

### 웹어드민 (convertMulti)
1. 줄바꿈 감지 (따옴표 홀수 감지) → 있으면 모달 + 중단
2. 번역 누락 감지 → 있으면 경고 모달 표시 (계속 변환 또는 닫기 선택)
3. 각 행을 탭으로 분리
4. C열(`cols[2]`)이 `'삭제'`인 행은 건너뜀
5. 언어별 컬럼 인덱스: KR=1, EN=3, DE=4, ... (`colIndex = li === 0 ? 1 : li + 2`)
6. `convertLines(symbols, texts, addDiv)` 호출
7. 하단 템플릿 체크 시 `FOOTER_TEMPLATES[lang]` 추가

### 스팀 (convertSteamMulti)
1. 줄바꿈 감지 → 있으면 모달 + 중단
2. 번역 누락 감지 → 있으면 경고 모달 표시 (계속 변환 또는 닫기 선택)
3. `LANG_COLS = ['KR','_','EN','DE',...]` 기준으로 `cols[idx+1]`로 텍스트 읽기
4. C열(`cols[2]`)이 `'삭제'`인 행은 건너뜀
5. `sym + (text && sym ? '\t' + text : text)` 형태로 langData에 push
6. 각 lang에 대해 `runSteamConvert(langData[lang].join('\n'))` 호출
7. 하단 템플릿 체크 시 `STEAM_FOOTERS[lang]` 추가

**이전 버그 수정 이력**:
- `value.trim()`이 첫 행의 leading tab을 제거해 언어 컬럼이 밀리던 문제 → `value` + `!raw.trim()` 분리로 수정

---

## 7. CSV 추출 (exportSteamCSV)

steamMultiResults를 아래 구조로 CSV 변환:
```
language,body,subtitle,summary,title
korean,"[p]...",,,패치 노트 버전 X.XX.XX
english,"[p]...",,,Patch Notes Version X.XX.XX
...
```

- 버전명 미입력 시 alert + 중단
- body의 큰따옴표는 `""` 이스케이프
- UTF-8 BOM(`\uFEFF`) 포함
- 언어 순서: `Object.entries(STEAM_LANG_MAP)` — **이것도 순서 보장 안 됨 (버그 연관)**

Steam language 매핑:
```
KR→korean, EN→english, DE→german, ES-ES→spanish, ES-MX→latam,
FR→french, IT→italian, PL→polish, PT-BR→brazilian, TR→turkish,
RU→russian, CN→schinese, TW→tchinese, JP→japanese
```

title 템플릿:
```
KR: 패치 노트 버전 {version}
EN: Patch Notes Version {version}
DE: Patch-Notizen: Version {version}
ES-ES/ES-MX: Versión de Nota de Parche {version}
FR: Notes de patch version {version}
IT: Note della Patch, Versione {version}
PL: Aktualizacja {version} - Lista zmian
PT-BR: Notas de Atualização {version}
TR: Yama Notları - Versiyon {version}
RU: Патчноут {version}
CN: 更新笔记版本{version}
TW: 更新筆記 版本 {version}
JP: パッチノート Ver.{version}
```

---

## 8. C열 '삭제' 행 필터링

C열(`cols[2]`) 값이 `'삭제'`인 행은 **모든 변환 함수에서 해당 행 전체를 무시**.

적용 위치:
- `convertSteamMulti()` — `lines.forEach` 내 첫 번째 조건
- `convertMulti()` — `rows` 배열 생성 시 `.filter()` 체인
- `convert()` (단일 웹어드민) — `lines` 배열 생성 시 `.filter()` 체인

번역가가 해당 행을 삭제 예정으로 표시할 때 C열에 `삭제`를 입력하면 변환 결과에서 자동 제외됨.

---

## 10. 줄바꿈 감지 로직

엑셀 셀 내 줄바꿈이 있으면, 복사 시 해당 셀이 `"따옴표"`로 감싸져서 탭 파싱이 깨짐.  
이를 감지하는 방식:

```javascript
// 따옴표가 홀수 개인 셀 = 줄바꿈으로 열린 상태
if (quoteCount % 2 === 1) → inQuote = true (시작)
// 다음 줄에서 다시 홀수 따옴표 → 닫힘
if (quoteCount % 2 === 1) → inQuote = false (끝)
```

감지 시 **모달 표시 + 변환 중단**.  
수정 방법: 엑셀에서 Ctrl+H → 찾을 내용에 Ctrl+J → 모두 바꾸기

---

## 11. 번역 누락 감지 로직

`detectMissingTranslations(raw)` 함수가 다국어 입력 전체를 검사:

```javascript
const LANG_COL_INDICES = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]; // B, D~P열
const LANG_NAMES = ['KR', 'EN', 'DE', 'ES-ES', 'ES-MX', 'FR', 'IT', 'PL', 'PT-BR', 'TR', 'RU', 'CN', 'TW', 'JP'];
```

- `삭제` 행 건너뜀
- 전체 언어 컬럼이 모두 비어있으면 빈 행으로 간주하고 건너뜀
- 공백/전각공백(`　`)만 있어도 빈 것으로 처리: `!v.replace(/[\s　]/g, '')`
- 언어별로 그룹화하여 반환: `{ 'DE': ['텍스트1', ...], 'TR': ['텍스트2'] }`

반환값이 있으면 `showMissingModal(grouped, callback)`을 호출해 언어별 누락 목록을 모달로 표시.  
KR 누락도 동일하게 감지 가능 (단, 레이블이 부호 또는 '내용 없음'으로 표시됨).

---

## 12. 모달 시스템

단일 모달(`#modal-overlay`)을 두 용도로 공유. 표시 시 제목/설명/버튼을 동적으로 설정.

| 용도 | 제목 | 버튼 |
|------|------|------|
| 줄바꿈 감지 | ⚠️ 줄바꿈이 포함된 셀이 감지되었습니다 | **닫기** (변환 중단) |
| 번역 누락 감지 | ⚠️ 번역 누락이 감지되었습니다 | **계속 변환하기** + **닫기** |

관련 JS 함수:
- `showMissingModal(grouped, onProceed)` — 누락 언어별 그룹화해서 표시, proceed 콜백 등록
- `proceedModal()` — 계속 변환하기 클릭 시 콜백 실행 후 모달 닫기
- `closeModal(event)` — 닫기 또는 오버레이 클릭 시 콜백 초기화 + 닫기
- `_modalProceedFn` — 현재 등록된 proceed 콜백 저장 변수

---

## 13. 하단 템플릿

### 웹어드민 (FOOTER_TEMPLATES)
14개 언어별 HTML 코드. 알려진 문제점 링크 + FAQ/오류제보 버튼 + 마무리 인사.  
`cd_tpl_divider`, `cd_tpl_btn_common big parchment` 등 어드민툴 전용 클래스 사용.

### 스팀 (STEAM_FOOTERS)
14개 언어별 BBCode. 알려진 문제점 `[url]` + HR + FAQ/오류제보 링크 + 마무리 인사.  
URL은 공통: `https://crimsondesert.pearlabyss.com/News/Notice/Detail?_boardNo=68` (알려진 문제)  
URL은 공통: `https://crimsondesert.pearlabyss.com/News/Notice/Detail?_boardNo=63` (FAQ)  
URL은 공통: `https://pearlabyss.info/crimsondesertreport` (오류 제보)

---

## 14. 파일 버전 관리

- 파일명: `patchnote_converter_YYMMDD_vN.html`
- GitHub에 올릴 때만 `index.html`로 이름 변경
- GitHub Pages: `https://dltmddn09.github.io/patchnote-converter`

---

## 15. Git 레포 구성

패치노트 변환기는 `ops-tools` 서브모듈(GitHub 레포: `dltmddn09/ops-tools`, `main` 브랜치) 소속. `ops-tools`는 상위 레포 `claude-work`(`dltmddn09/claude-work`, `master` 브랜치)의 서브모듈로 포함됨.

| 로컬 경로 | 용도 |
|---|---|
| `e:\Claude code\ops-tools\patchnote-converter\` | 패치노트 변환기 (index.html + LOGIC.md + CLAUDE.md) |
| `e:\Claude code\ops-tools\build-timeline\` | 빌드 타임라인 |
| `e:\Claude code\ops-tools\dlc-pricing-research\` | DLC 가격 조사 |
| `e:\Claude code\헤이박스 계산기\` | 헤이박스 계산기 (ops-tools 서브모듈) |

**이전 구조 변경 이력**:
- `d:\HTML 모음\` 하위 폴더에서 각각 독립 레포로 관리하던 방식을 claude-work 단일 레포로 통합 (2026-06-19)
- 헤이박스 계산기/패치노트 변환기/빌드 타임라인/DLC 가격 조사 4개 도구를 `ops-tools` 서브모듈 레포로 재통합 — URL 전부 변경됨

이 폴더 관련 커밋/푸시는 `ops-tools` 서브모듈 자체에서 이루어지며, 이후 상위 `claude-work` 레포의 서브모듈 포인터도 별도로 갱신·커밋해야 함.

Claude Code 세션은 항상 `e:\Claude code\ops-tools\patchnote-converter` 또는 `e:\Claude code` 기준으로 실행.
