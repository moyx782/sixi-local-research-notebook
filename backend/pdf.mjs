import { AppError } from './input.mjs';

export async function pdfInput(input) {
  if (typeof input.base64 !== 'string' || input.base64.length > 7_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64))
    throw new AppError('PDF 文件格式无效或超过 5 MB');
  const bytes = Buffer.from(input.base64, 'base64');
  if (bytes.length > 5_000_000 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new AppError('请选择 5 MB 以内的 PDF 文件');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
  try {
    const doc = await loading.promise;
    if (doc.numPages > 100) throw new AppError('每份 PDF 最多 100 页，请拆分后导入');
    const pages = [];
    let size = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str === undefined ? '' : item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
      size += text.length;
      if (size > 450_000) throw new AppError('PDF 文本量过大，请拆分后导入');
      if (text) pages.push(`【PDF 第 ${number} 页】\n${text}`);
      page.cleanup();
    }
    if (!pages.length) throw new AppError('此 PDF 没有可提取的文字；扫描件需要先完成 OCR');
    return { type: 'text', title: input.title || 'PDF 资料', content: pages.join('\n\n') };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(error.name === 'PasswordException' ? 'PDF 受密码保护，请先解锁后再导入' : '无法解析此 PDF，请检查文件是否完整', 422);
  } finally { await loading.destroy(); }
}
