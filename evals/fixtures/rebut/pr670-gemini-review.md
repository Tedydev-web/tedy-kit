# Gemini review pasted for PR #670 (2026-09-30T01:45Z)

đây là review của Gemini cho PR 670 nè, bạn hãy xem, phân tích, so sáng và đánh giá lại nếu đúng nhận còn sai thì phản biện rồi tí tổng hợp lại với reviewer độc lập nữa để làm những cái đúng:

"

<pasted_content id="dd76">
## Standards

Dưới góc nhìn của một Senior Dev khắt khe, diff này chứa nhiều đoạn code viết theo kiểu "đối phó" (AI-Slop), tiềm ẩn bug logic state và vi phạm các nguyên tắc Clean Code:

* **Tiềm ẩn Bug State / Data Mixing (Báo động đỏ cho Web3/Finance):** Trong `use-activity-history.ts`, `vaultId` được ném thêm vào dependency array của `useEffect` (dòng 42, 52). Tuy nhiên, không có logic nào reset mảng `rows` hay biến `nextPage.current` về 1 khi `vaultId` thay đổi. Nếu user chuyển qua lại giữa các vault, transaction history của vault cũ và mới sẽ bị append (trộn lẫn) vào nhau. Lỗi chết người đối với app hiển thị dòng tiền.
* **Dirty Code / Nested Ternary:** Trong `family-copy.ts` (dòng 164-170), đoạn xử lý `destination` sử dụng nested ternary operator (`a ? b : c ? d : e`). Đây là đặc sản của AI-slop, cực kỳ khó đọc và bảo trì. Bắt buộc phải refactor thành `if/else` hoặc một parser function riêng.
* **Duplicated Code / Bad Component Design:** Trong `vault-activity-list.tsx` (dòng 104-118), biến `{body}` bị ép phải viết lặp lại ở cả hai nhánh render `<button>` và `<div>` chỉ để check xem có `activity.route` hay không. Thay vì lặp code, hãy dùng Polymorphic component (VD: `<Wrapper 'button' 'div'} : ? as="{activity.route"> {body} </Wrapper>`).
* **Condition Hell / Spaghetty Logic:** Khối logic check loading/error/empty state ở `vault-activity-list.tsx` (dòng 31-60) nhét mọi thứ vào một cục ternary `failed ? ... : isDone ? ... : ...` rồi vứt vào biến `message`. Tệ. Hãy sử dụng Early Return: if failed -> return ErrorComponent, if isDone -> return EmptyComponent.
* **Data Clumps (Khởi đầu của Parameter Hell):** API `activityApi.history` bị nhét thêm tham số thứ 4 dạng optional `vaultId?: string`. Cứ đà này thêm vài filter nữa hàm sẽ nát. Gom toàn bộ tham số vào một Object `{ spaceId, page, limit, vaultId }` ngay từ bây giờ.

## Spec

*Spec được nội suy từ PR Title: "feat(family): money bells, member left and vault activity"*

* **Requirements được đáp ứng:** Các UI về `VaultActivityList`, bổ sung mapping regex cho các loại chuông báo mới (`member_left`, `money_out`) và file dịch đa ngôn ngữ đã được thêm vào đủ.
* **Implementation có rủi ro cao:** Yêu cầu "vault activity" được implement nhưng lại dính lỗi thiết kế hook `useActivityHistory` như đã nêu ở phần Standards. Điều này dẫn đến tính năng hoạt động bề nổi nhưng sẽ trả về sai lệch lịch sử giao dịch (balance/ledger) nếu component không bị unmount hoàn toàn khi đổi vault.

**Tổng kết:** Standards: 5 vấn đề | Spec: 1 vấn đề (lỗi implementation). Nghiêm trọng nhất ở cả 2 trục là việc quên dọn dẹp state khi fetch lịch sử giao dịch vault, rủi ro cực lớn cho một ví Web3.
</pasted_content id="dd76">

"
