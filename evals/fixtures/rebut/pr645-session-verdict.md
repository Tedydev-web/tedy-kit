# Verdict the Dev session reached for PR #645

Anh ơi, #645 có một lỗi thật mà Gemini chỉ đúng: Home gọi API giá token nhưng kết quả luôn bị nhân với 0. Em đã xoá phần gọi giá đó, push lên và đưa xuống cả stack. Các PR #645 → #638 vẫn `CLEAN`.

**Đánh giá từng điểm của Gemini** (em và reviewer độc lập cùng kết luận)

| # | Gemini nói | Kết luận | Bằng chứng |
|---|---|---|---|
| 1 | Giá token nhân với `'0.00'` nên luôn ra `~ $0`, gọi API giá là thừa | **Đúng, đã sửa** | BE chưa có số dư riêng cho từng vault, nên số dư đang cố định `0.00`. Các lần gọi giá không làm thay đổi gì trên màn hình. |
| 2 | Nhân bằng `Number()` làm sai số, phải dùng bignumber | **Sai** | Phép nhân chỉ để hiển thị, đã làm tròn 2 chữ số, và không có phép tính số dư thật nào. |
| 3 | Tự fetch bằng `useEffect` và cờ `cancelled`, không có AbortController, nuốt lỗi; bắt buộc dùng React Query/SWR | **Đúng một phần** | Repo không cài React Query hay SWR. Hook cùng thư mục (`use-stampi-balance`) cũng dùng đúng mẫu này, và cờ `cancelled` vẫn chặn được kết quả cũ ghi đè. Riêng ý "không có trạng thái lỗi" là đúng, chi tiết ở mục "Còn mở". |
| 4 | `Promise.all` gọi API giá cho từng symbol, dễ bị rate-limit | **Đúng một phần** | Mỗi symbol là một POST, nhưng đã lọc trùng symbol và không gọi lại khi refresh, nên chưa đến mức spam. Phần code này cũng đã bị xoá theo mục 1. |

**Đã sửa**
- Xoá `use-token-prices-usd.ts` và tham số `priceUsd`. Chip hiện thẳng `~ $0` cho tới khi BE trả số dư vault.
- Đưa bản sửa xuống #646 → #638 bằng merge thường. Ở #646 có một chỗ conflict nhỏ trong `shared-vault-page.tsx`: nhánh này đang gọi giá cho trang chi tiết vault. Em giữ `isEditOpen` và bỏ phần gọi giá.

**Sự cố trong lúc làm**
- Lần đầu lan bản sửa, script của em chèn trùng dòng `const UNFUNDED_FIAT` ở mỗi nhánh phía sau (từ 2 đến 5 dòng).
- Em phát hiện trước khi push. Em reset 4 nhánh đó về origin, chỉ bỏ các commit local vừa tạo, rồi lan lại bằng script đã sửa.
- Kiểm tra lại: diff của nhánh cuối so với origin đúng bằng thay đổi mong muốn (4 file, +7/−38). Trên remote không có commit lỗi nào.

**Đã kiểm tra**
- `tsc` trên cả 5 nhánh: không có lỗi mới.
- `react-router build` trên nhánh cuối: pass.
- Nhánh local `local/family-vaults-full` đã cập nhật.

**Còn mở, cần anh hoặc PM chốt (em chưa sửa vì cần quyết định UX)**
1. **Không phân biệt lỗi với rỗng.** Khi tải danh sách vault lỗi, khu Vaults trống trơn, giống hệt một ví chưa có vault. Khi tải balance lỗi, số tổng hiện `-` mãi, giống lúc đang tải. Đề xuất: hiện dòng lỗi kèm nút "Thử lại", còn câu chữ cần PM chốt. Việc này trùng với câu hỏi cũ về giao diện khi tải vault lỗi.
2. **Cờ `partial` bị bỏ qua.** BE có trả cờ này khi tổng tiền thiếu dữ liệu một chain, nhưng FE không đọc. Tổng bị thiếu vẫn hiện như số đầy đủ. Có cần một dấu hiệu nào không?
3. **Nút refresh không có phản hồi.** Khi đã có sẵn danh sách, bấm refresh không thấy gì thay đổi, và bấm liên tục được.
4. **Vài chi tiết hiển thị:**
   - Lúc space chưa tải xong, card hiện "0 Members".
   - Chữ "- unallocated" trong sheet Buy Stamps.
   - Icon token rỗng thành ảnh vỡ.
   - Goal hiện `saved: '0'` không có đơn vị.
