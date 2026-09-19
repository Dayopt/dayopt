import { dayoptContact } from '@dayopt/config';
import type { ReactNode } from 'react';

import { readLegalText, readLegalTree, type LegalContentTree } from './legal-content-tree';

function TableHeader({ children }: { children: ReactNode }) {
  return (
    <th className="bg-container text-foreground w-1/3 px-6 py-4 text-left text-sm font-medium">
      {children}
    </th>
  );
}

function PlaceholderCell({ data, item }: { data: LegalContentTree; item: LegalContentTree }) {
  return (
    <td className="text-foreground px-6 py-4 text-sm">
      <span className="bg-muted text-warning-foreground rounded-lg px-2 py-1 text-xs font-medium">
        {readLegalText(data, 'placeholder')}
      </span>
      <span className="text-muted-foreground ml-2 text-xs">{readLegalText(item, 'hint')}</span>
    </td>
  );
}

function ListRow({ item, keys }: { item: LegalContentTree; keys: readonly string[] }) {
  return (
    <tr>
      <TableHeader>{readLegalText(item, 'label')}</TableHeader>
      <td className="text-foreground px-6 py-4 text-sm">
        <ul className="list-inside list-disc space-y-1">
          {keys.map((key) => (
            <li key={key}>{readLegalText(item, key)}</li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

function ContentRow({ item }: { item: LegalContentTree }) {
  return (
    <tr>
      <TableHeader>{readLegalText(item, 'label')}</TableHeader>
      <td className="text-foreground px-6 py-4 text-sm">{readLegalText(item, 'content')}</td>
    </tr>
  );
}

export function TokushohoDocument({ data }: { data: LegalContentTree }) {
  const setupNotice = readLegalTree(data, 'setupNotice');
  const items = readLegalTree(data, 'items');

  return (
    <>
      <div className="bg-muted border-warning mb-8 rounded-2xl border-2 border-dashed p-6">
        <div className="flex items-start gap-4">
          <span className="text-2xl">📝</span>
          <div>
            <p className="text-warning-foreground font-medium">
              {readLegalText(setupNotice, 'title')}
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {readLegalText(setupNotice, 'description')}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-card border-border-subtle overflow-hidden rounded-2xl border shadow-sm">
        <table className="w-full">
          <tbody className="divide-border divide-y">
            {['seller', 'representative', 'address'].map((key) => {
              const item = readLegalTree(items, key);
              return (
                <tr key={key}>
                  <TableHeader>{readLegalText(item, 'label')}</TableHeader>
                  <PlaceholderCell data={data} item={item} />
                </tr>
              );
            })}

            <tr>
              <TableHeader>{readLegalText(items, 'contact', 'label')}</TableHeader>
              <td className="text-foreground px-6 py-4 text-sm">
                <div className="space-y-1">
                  <p>
                    <span className="text-muted-foreground">
                      {readLegalText(items, 'contact', 'emailLabel')}:
                    </span>{' '}
                    {dayoptContact.supportEmail}
                  </p>
                  <p>
                    <span className="text-muted-foreground">
                      {readLegalText(items, 'contact', 'phoneLabel')}:
                    </span>{' '}
                    <span className="bg-muted text-warning-foreground rounded-lg px-2 py-1 text-xs font-medium">
                      {readLegalText(data, 'placeholder')}
                    </span>
                  </p>
                </div>
              </td>
            </tr>

            <ContentRow item={readLegalTree(items, 'price')} />
            <ListRow item={readLegalTree(items, 'payment')} keys={['creditCard']} />
            <ContentRow item={readLegalTree(items, 'paymentTiming')} />
            <ContentRow item={readLegalTree(items, 'delivery')} />
            <ListRow
              item={readLegalTree(items, 'cancellation')}
              keys={['anytime', 'noRefund', 'access']}
            />
            <ListRow item={readLegalTree(items, 'environment')} keys={['browser', 'internet']} />
            <ListRow item={readLegalTree(items, 'notes')} keys={['autoRenewal', 'priceChange']} />
          </tbody>
        </table>
      </div>
    </>
  );
}
