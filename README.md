# utsukuba

筑波大学向けの read-only CLI です。manaba、KDB、TWINS/CAMPUSSQUARE、履修要件・履修計画を扱います。

LinuxでのID・パスワード保存にはGoogle Secret Managerを利用できます。
設定と保存先については[Linux credential storage](docs/linux-credentials.md)を参照してください。

## Local Development Install

このリポジトリを直接触る開発者向けです。

```sh
bun install
cd packages/cli
bun link
```

これで `~/.bun/bin/utsukuba` と `~/.bun/bin/manaba` が作られます。`~/.bun/bin` が PATH に入っていれば、どこからでも実行できます。

```sh
utsukuba --help
utsukuba login
utsukuba tasks list
```

## Install From GitHub

リポジトリを GitHub に置いた後は、利用者は次の形でインストールできます。

```sh
bun install -g github:<owner>/<repo>
```

例:

```sh
bun install -g github:tka1utjp/utsukuba-cli
```

更新するとき:

```sh
bun install -g github:tka1utjp/utsukuba-cli
```

アンインストール:

```sh
rm -f ~/.bun/bin/utsukuba ~/.bun/bin/manaba
```

## Single Binary Distribution

Bun を入れていない人には、単一バイナリを配れます。

```sh
bun run build
./dist/utsukuba --help
```

作られた `dist/utsukuba` を配布します。macOS でビルドしたバイナリは基本的に同じOS/CPU向けです。複数OS向けに配る場合は GitHub Actions で OS ごとにビルドしてください。

利用者側で PATH に置く例:

```sh
mkdir -p ~/.local/bin
cp utsukuba ~/.local/bin/utsukuba
chmod +x ~/.local/bin/utsukuba
```

## First Login

```sh
utsukuba login
utsukuba login --check --pretty
utsukuba twins login
utsukuba twins doctor --pretty
```

manaba と TWINS は同じID/パスワードを使う前提です。セッション Cookie はサービス別に保存し、再ログイン用の資格情報は macOS Keychain に保存します。

- Cookie: `~/.utsukuba-cli/profiles/<profile>/<service>/auth.json`
- Keychain credential service: `utsukuba-cli`

## Common Commands

```sh
utsukuba tasks list --pretty
utsukuba courses list --pretty
utsukuba quizzes list <courseId> --pretty
utsukuba reports list <courseId> --pretty
utsukuba contents list <courseId> --pretty
utsukuba contents inspect <pageUrlOrId> --json
utsukuba files list <courseId> --pretty
utsukuba files download "<file-url>" --out ./downloads
```

`contents inspect` は、同じmanabaサイトの教材ページ・ドリル入口・既存の採点結果を
1回のGETで読み、本文・観測したリンク・埋め込み先・値を除いたフォーム構造を表示します。
リンク先の自動巡回やJavaScript実行はせず、認証情報・hidden値は表示しません。
受験開始・回答入力・提出は行いません。INFOSSのテストは `drill` 形式のため、
`quizzes list` が空でも教材本文のリンクと既存の合格記録を確認してください。

## Question extraction and answer drafts

```sh
utsukuba --json contents questions <pageUrlOrId>
utsukuba --json contents answer-plan <pageUrlOrId> --answers /private/path/answers.json
# Equivalent namespace: utsukuba manaba contents questions ...
```

`questions` は既存ページのradio/checkbox設問を `{url, questions: [{questionId,
type, required, prompt, options: [{optionId, text}]}]}` に構造化します。
既存回答のchecked/selected状態・採点コメントは返しません。対応範囲はManabaの
`ol.queryselection`直前の設問段落、または`fieldset`/`legend`です。
未対応の自由記述・select・曖昧な構造・問題のないページはエラーにします。

回答案ファイルはGit外に保存し、次の厳密なJSON形式を使います（余分なキー不可）。
`questionId`と`optionIds`は抽出結果の文字列IDを使ってください。

```json
{"answers":[{"questionId":"qid1","optionIds":["2"],"reason":"選択理由を記述"}]}
```

全設問を重複なく含める必要があります。radioは必ず1個、必須checkboxは1個以上、
任意checkboxは空配列でも構いません。理由は空でない文字列が必須です。
未知の設問・他の設問の選択肢・選択肢重複・不正スキーマを拒否します。
成功結果は`valid:true, mode:"draft", submitted:false`と、設問ごとの選択肢本文・理由です。
`valid`は構造検証のみを意味し、正答判定や新たな採点ではありません。
CLI自体はモデル呼出しやモデル認証情報を持ちません。抽出結果から利用者・エージェントが
推論して案を作り、このコマンドで整合性を検証します。

両コマンドは`contents inspect`と同じ許可済みの受動URLだけを、保存済みセッションで
1回GETします。リダイレクト・自動ログイン・リンク巡回・受験開始・回答入力・POST・提出は行いません。
hidden/password/session/CSRF値は返しません。公開教材リンクの扱いは既存のinspectから変更しません。

## KDB

```sh
utsukuba kdb courses --year 2026 --query GC11601 --include-syllabus --pretty
utsukuba kdb syllabus show GC11601 --year 2026 --lang jpn --pretty
utsukuba kdb syllabus html GC11601 --year 2026 --lang jpn
```

KDB は公開情報として扱うためログイン不要です。検索はKDBの `SB0070`、シラバス表示は `SB0220` の実ページと同じPOSTパラメータを使います。

## TWINS

```sh
utsukuba twins login
utsukuba twins profile --pretty
utsukuba twins menus --pretty
utsukuba twins registrations --pretty
utsukuba twins grades --pretty
utsukuba twins summary --pretty
utsukuba twins html --url "portal.do?page=main"
```

TWINS はCAMPUSSQUAREのメニュー/flowIdがログイン後HTMLに依存するため、`registrations` と `grades` は通常メニューから自動検出します。検出できない場合や保存HTMLを解析したい場合だけ、`--url <path-or-url>` で対象ページを明示できます。

`summary` はTWINS成績からGPA、修得単位、未修得単位、履修中単位を集計します。GPAは筑波大学のGP表に合わせて `A+=4.3 / A=4 / B=3 / C=2 / D=0` を使い、`P` と `F` はGPA分母から外します。

## Requirements and Planning

履修要件はCLIが解釈しやすいJSONにしてから取り込みます。

```json
{
  "program": "情報学群 情報科学類",
  "admissionYear": "2025",
  "categories": [
    { "id": "major", "name": "専門", "minCredits": 20, "coursePrefixes": ["GE"] }
  ],
  "courseRules": [],
  "notes": []
}
```

```sh
utsukuba requirements fetch-handbook --year 2025 --pretty
utsukuba requirements import --file requirements.json --name default
utsukuba requirements show --name default --pretty
utsukuba plan progress --grades grades.json --registrations registrations.json --pretty
utsukuba plan recommend --courses kdb-courses.json --grades grades.json --registrations registrations.json --pretty
```

## Repo Skills

複雑な判断はCLI本体に埋め込まず、Repo内Skillとして分けています。

- `skills/utsukuba-requirements`: 履修要件資料をCLI用JSONへ構造化
- `skills/utsukuba-course-planning`: TWINS/KDB/要件JSONから履修計画とおすすめ候補を作成
- `skills/utsukuba-manaba-context`: manabaコースとKDBシラバスを結合して文脈化
