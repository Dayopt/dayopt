import { ErrorLayout } from '@web/components/errors/ErrorLayout';
import { generateSEOMetadata } from '@web/platform/seo/metadata';
import { Document } from '@web/shell/layout/Document';

export const metadata = generateSEOMetadata({
  title: 'Page Not Found - 404 Error',
  description:
    'The page you are looking for could not be found. Return to our homepage or browse our available content.',
  url: '/404',
  noindex: true,
});

export default function NotFound() {
  return (
    <Document>
      <ErrorLayout
        code="404"
        title="Page not found"
        description="Sorry, we couldn't find the page you're looking for."
      />
    </Document>
  );
}
