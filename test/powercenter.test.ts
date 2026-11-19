import { describe, expect, it } from 'vitest';
import { decodeExport, findPort, parseExport, tableKey } from '../src/powercenter.ts';
import { UnsupportedError } from '../src/errors.ts';
import { exportXml } from './support/mapping-xml.ts';

describe('reading an export', () => {
  it('rejects a file that is not a PowerCenter export', () => {
    expect(() => parseExport('<html><body/></html>')).toThrow('is this a PowerCenter export?');
    expect(() => parseExport('')).toThrow('is this a PowerCenter export?');
  });

  it('decodes the bytes with the encoding the export declares', () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('<?xml version="1.0" encoding="Windows-1252"?><A>'), 0xe9, ...new TextEncoder().encode('</A>')]);
    expect(decodeExport(bytes)).toContain('<A>é</A>');
  });

  it('assumes UTF-8 when there is no declaration', () => {
    expect(decodeExport(new TextEncoder().encode('<A>é</A>'))).toBe('<A>é</A>');
  });

  it('reads every folder of every repository', () => {
    const folders = parseExport(exportXml(['<FOLDER NAME="ONE"/>', '<FOLDER NAME="TWO"/>']));
    expect(folders.map((folder) => folder.name)).toEqual(['ONE', 'TWO']);
  });

  it('makes the reusable transformations of a folder available to its mappings', () => {
    const [folder] = parseExport(exportXml(['<FOLDER NAME="F"><TRANSFORMATION NAME="R" TYPE="Expression"/><MAPPING NAME="M"/></FOLDER>']));
    expect(folder!.mappings[0]!.transformations.has('R')).toBe(true);
  });

  it('keeps two source tables of the same name from different databases apart', () => {
    const [folder] = parseExport(
      exportXml(['<FOLDER NAME="F"><SOURCE NAME="CUSTOMERS" DBDNAME="CRM" OWNERNAME="A"/><SOURCE NAME="CUSTOMERS" DBDNAME="ERP" OWNERNAME="B"/></FOLDER>']),
    );
    expect(folder!.sources.get(tableKey('CRM', 'CUSTOMERS'))!.owner).toBe('A');
    expect(folder!.sources.get(tableKey('ERP', 'CUSTOMERS'))!.owner).toBe('B');
  });

  it('skips sessions and workflows without reading them', () => {
    const [folder] = parseExport(exportXml(['<FOLDER NAME="F"><SESSION NAME="s"><BROKEN></SESSION><MAPPING NAME="M"/></FOLDER>']));
    expect(folder!.mappings.map((mapping) => mapping.name)).toEqual(['M']);
  });

  it('finds ports by name, and reports a missing one', () => {
    const [folder] = parseExport(
      exportXml(['<FOLDER NAME="F"><MAPPING NAME="M"><TRANSFORMATION NAME="E" TYPE="Expression"><TRANSFORMFIELD NAME="A" PORTTYPE="INPUT"/></TRANSFORMATION></MAPPING></FOLDER>']),
    );
    const expression = folder!.mappings[0]!.transformations.get('E')!;
    expect(findPort(expression, 'A').portType).toBe('INPUT');
    expect(() => findPort(expression, 'B')).toThrow(UnsupportedError);
  });

  it('looks mapping parameters up case-insensitively', () => {
    const [folder] = parseExport(exportXml(['<FOLDER NAME="F"><MAPPING NAME="M"><MAPPINGVARIABLE NAME="$$Run_Date" DATATYPE="date/time"/></MAPPING></FOLDER>']));
    expect(folder!.mappings[0]!.variables.get('$$RUN_DATE')?.name).toBe('$$Run_Date');
  });
});
