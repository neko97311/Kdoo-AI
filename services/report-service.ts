import { api } from '@/services/api';
import { uploadFile } from '@/services/upload-service';

export type ProblemType = 'general' | 'feedback' | 'child_safety' | 'reply_feedback';

export interface ReportProblemPayload {
  type: ProblemType;
  description: string;
  images?: string[];
}

const REPORT_ENDPOINT = '/api/user/v1/report-problem';

/**
 * 提交问题报告。
 *
 * 流程：
 * 1. 如果有本地图片，先逐个上传到 OSS 获取远程 URL
 * 2. 将问题类型、描述和图片 URL 列表 POST 到服务端
 *
 * @param type         问题类型
 * @param description  问题描述
 * @param localImages  本地图片 Attachment 数组（uri + mediaType + name）
 */
export async function submitReport(
  type: ProblemType,
  description: string,
  localImages?: Array<{ uri: string; mediaType: string; name: string }>,
): Promise<void> {
  // Step 1: Upload images (if any)
  const imageUrls: string[] = [];

  if (localImages && localImages.length > 0) {
    for (const img of localImages) {
      try {
        const url = await uploadFile(img.uri, img.mediaType, img.name);
        imageUrls.push(url);
      } catch (err: any) {
        console.warn('[ReportService] Failed to upload image, skipping:', img.name, err.message);
        // Skip images that fail to upload
      }
    }
  }

  // Step 2: Submit report
  await api.post<null>(REPORT_ENDPOINT, {
    type,
    description,
    images: imageUrls.length > 0 ? imageUrls : undefined,
  });
}