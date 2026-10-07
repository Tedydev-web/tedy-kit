# Verdict the Dev session reached for PR #670

Reviewer độc lập cũng xác nhận cả 5 điểm Gemini nêu cho #670 đều sai. Nhưng reviewer tìm ra 2 lỗi thật mà Gemini bỏ sót; em đã sửa cả hai và push lên #670 (commit `4ee5e775`), rồi merge sang #671.

**Đã sửa trên #670:**
- **Vault activity chỉ tải 20 dòng đầu, không báo gì.** Vault có hơn 20 activity sẽ mất các khoản chi và lần chuyển tiền cũ. PRD UC_FW_10 yêu cầu Activity liệt kê những gì đã tính vào vault, và BR3 ghi không có bản lịch sử rút gọn nào khác trong sản phẩm. Giờ danh sách tự tải thêm khi cuộn, giống màn History, và có Loading/Retry ở cuối.
- **Bell "request approved" chỉ khớp đúng key `request_approved.title`.** Catalog còn key `request_approved.title_you` ("Your request to … was approved"). Nếu BE gửi key này, bell sẽ mở nhầm Approvals thay vì Transaction details. Đã sửa và thêm test.

Kiểm tra: trên #670 tsc 0 lỗi, build family exit 0, 73/73 test, no-comments sạch. Sau khi merge sang #671: tsc 0 lỗi, 76/76 test, đã push.

**Không sửa:**
- **Add money đã duyệt nhưng chờ tiền, mở Approvals hay details?** Reviewer lo `spend_request` đã duyệt sẽ mở sai chỗ. BE doc (dòng 158) cho mở details, còn bảng UC_FW_07 của PRD cho mở Approvals. Em giữ theo PRD như anh đã chốt.
- **`destination` dạng chuỗi không rút gọn địa chỉ.** Reviewer cũng chỉ ở mức nghi ngờ. BE doc không nói khi nào `destination` là chuỗi, và đó có thể là tên chứ không phải địa chỉ. Chưa có hợp đồng thì em không đoán.

**Kết luận về Gemini, sau khi gộp 2 review:**
- Ở #671, Gemini đúng một điểm: `throw Symbol` làm control flow. Em đã sửa từ trước (commit `b0195884`).
- Ở #670, cả 5 điểm đều sai, cả hai reviewer cùng kết luận vậy.
- Điểm nghiêm trọng nhất Gemini nêu là "lịch sử các vault trộn vào nhau". Điểm này sai về dữ kiện: hook có effect reset khi đổi vault và có kiểm tra `generation` để bỏ response cũ.

Merge #670 trước, rồi đến #671 (dùng "Create a merge commit").

Câu hỏi còn mở:
1. BE có gửi `request_approved.title_you` không? Trên `origin/dev` em không tìm thấy key này.
2. Server có trả row `spend_request` cho Add money đang chờ duyệt không?
3. `GET …/requests` có phân trang không?
4. Nút trên thanh details dùng "Send now · no stamp" (theo PRD) hay giữ "Move now · no stamp" (theo #668)?
