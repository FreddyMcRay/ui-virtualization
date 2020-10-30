export class SortValueConverter {
    public toView(array: any[], property: string) {
        return array.sort((a, b) => {
            let textA = a[property] && a[property].toUpperCase ? a[property].toUpperCase() : a[property];
            let textB = b[property] && b[property].toUpperCase ? b[property].toUpperCase() : b[property];
            return (textA < textB) ? -1 : (textA > textB) ? 1 : 0;
        });
    }
}