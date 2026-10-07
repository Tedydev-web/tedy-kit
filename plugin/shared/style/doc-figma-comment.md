# Google Doc and Figma comment style

How a comment on the PRD Doc or on a Figma frame reads: a quick chat between teammates, in Vietnamese. Measured on 14 Figma comments posted by the user's account and 8 Doc comments, all after the tone correction of 2026-10-02 06:25.

## Doc (PRD threads)

- Opens by placing the point: "Thêm 1 ý ở UC_LG_01 BR8 (Who moved money):", "Thêm 1 chỗ về chip category:", "Cho e hỏi lại xíu:", "Chỗ Must include e thấy reply với docs đang lệch nè a:".
- Cites UC and BR codes inside the sentence, says how em currently reads it, and gives a concrete case with real numbers ("vd 20/09 gửi 10 TON lúc TON $5 thì ghi $50").
- When there are options, numbers them inline: "(1) …, (2) …".
- Ends with the decision asked for: "A chốt giúp e cách nào nha", "Mình chốt cách nào a?", "a xác nhận giúp e nha".
- No @tag. Short forms a/e/ko/đc/vd. Length 231–463 characters.

## Figma (frame comments)

- Opens with `@handle` of whoever owns the fix: the designer for drawing changes, the PM for a product call (14/14 open with a handle; one comment may tag both, each with its own ask).
- States what the frame shows now, then what the PRD or the newer source says, quoting English copy exactly in straight quotes and citing UC codes.
- Ends with "nha" for a requested change (4/14) or a question ending "a?" for a decision (5/14).
- Pinned to the node it talks about. Median 266 characters, longest 517.

## Samples

Figma samples are the posted text re-read from the Figma API. Doc samples are the text as sent, taken from the request payloads in the PM session; sample 2 is the final text after its PATCH.

### 1. Doc, two options and a decision asked, 2026-10-05

```text
Thêm 1 ý về mấy dòng USD-normalized này luôn: BE hiện chưa lưu USD lúc settle trên dòng activity, đang bổ sung. Mấy dòng đã settle trước đó thì BE ko giữ lịch sử giá, nên lúc backfill có 2 cách: (1) lấy lại giá tại thời điểm settle của từng dòng, (2) để trống, dòng cũ ko tính vào Ledger nên tổng các kỳ cũ sẽ thiếu. Lấy giá hôm nay thì ko được vì BR2 cấm. A chốt giúp e cách nào nha
```

### 2. Doc, how em reads it, asking to confirm, 2026-10-05

```text
Thêm 1 ý ở UC_LG_01 BR8 (Who moved money): số của mỗi người có gồm phí mạng của giao dịch họ yêu cầu và stamp họ mua từ ví chung ko a? Nếu chỉ tính spend theo category thì tổng share ko đủ 100% Total out, vì phần Fees & stamps ko gán cho ai. E đang hiểu là gồm cả 2 để share cộng lại đúng Total out, a xác nhận giúp e nha
```

### 3. Doc, reply and docs disagree, concrete case, 2026-10-05

```text
Chỗ Must include e thấy reply với docs đang lệch nè a: reply ghi tạm chuyển quyền duyệt về Owner/Admin như case bị remove (UC_FW_04 BR6a), còn BR6a mới trong docs ghi coi như ko có tên đó, các approver khác với tỷ lệ tự quyết. Vd rule 50% + Must include Minho, Minho bị view-only: theo reply thì đủ 50% vẫn phải chờ 1 Owner/Admin duyệt, theo docs thì đủ 50% là xong. Mình chốt cách nào a?
```

### 4. Doc, follow-up question, 2026-10-02

```text
Cho e hỏi lại xíu: khi xem Ledger bằng KRW/VND thì mình lấy số USD đã lưu đổi theo tỷ giá hôm nay, hay theo tỷ giá lúc giao dịch a? Nếu theo tỷ giá hôm nay thì kỳ đã đóng xem bằng KRW sẽ đổi số mỗi ngày (USD thì giữ nguyên). Nếu theo tỷ giá lúc giao dịch thì BE phải lưu thêm tỷ giá từng currency cho mỗi giao dịch.
```

### 5. Figma, change request ending nha (node 3846:9117), 2026-10-06

```text
@mckinsie.donyle63 Hint đổi "The family votes on it." thành "The group votes on it." cho khớp PRD với chữ group toàn app nha
```

### 6. Figma, product question to the PM (node 4195:7230), 2026-10-04

```text
@PM_leon Toast kiểu glass + icon này khác PRD UC_FW_16 (pill tối 1 dòng ko icon) mà FE đang làm cho cả app, mình đổi cho toàn app luôn hay chỉ chỗ này a?
```

### 7. Figma, two handles, each with its own ask (node 4195:6898), 2026-10-02

```text
@mckinsie.donyle63 Bản chỉ đọc này chip vẫn còn ×, PRD (UC_LG_05 BR5) là Member ko có × với ko có ô thêm. Hint ghi 4 of 10 mà đang có 9 chip nha. @TON CORP lúc trước a có nói ẩn luôn entry Manage categories cho Member, mà frame này là sheet chỉ đọc (đúng PRD), mình chốt cái nào a?
```

### 8. Figma, frame out of step with another frame (node 2751:20084), 2026-10-07

```text
@TON CORP Frame History vẫn ghi chip "This month" với 1 dòng ngày "18 August 2026", còn Overview (2954:6897) đã là "Month" với hàng kỳ "14-20 August 2026". Sửa History cho giống Overview nha
```

## Avoid

| Pattern | Why (evidence) |
|---|---|
| "Anh ơi", thank-you lines, formal phrasing | Tone rule 2026-10-02: casual texting, a/e/ko/đc |
| Resolving a thread, including one the agent opened | The user reads open threads to check answers; resolving is theirs (working-style rule 4) |
| Replying under a thread on a different topic | Memory "PRD comment: ra file, không reply sai thread": a new question goes to an HTML file with the verified highlighted passage, and the user posts it |
| Reposting answered threads after a Figma restyle | Only unanswered threads are reposted |
| Paraphrased UI copy | Copy is quoted exactly so the designer can search the frame for it |
