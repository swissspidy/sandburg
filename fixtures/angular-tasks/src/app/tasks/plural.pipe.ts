import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'plural' })
export class PluralPipe implements PipeTransform {
  transform(count: number, singular: string, plural = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : plural}`;
  }
}
