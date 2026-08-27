import re
import csv

def parse_menu():
    with open('menu_data.txt', 'r') as f:
        content = f.read()

    menu_section = content.split('### ML Caterings Menu Option')[1] if '### ML Caterings Menu Option' in content else content
    
    categories = {}
    current_category = None
    
    lines = menu_section.split('\n')
    
    for line in lines:
        line = line.strip()
        
        category_match = re.match(r'^#\s+(.+)$', line)
        if category_match:
            current_category = category_match.group(1).strip()
            if current_category not in categories:
                categories[current_category] = []
            continue
        
        item_match = re.match'^[-*]\s+(.+)$', line)
        if item_match and current_category:
            item = item_match.group(1).strip()
            if item:
                categories[current_category].append(item)
    
    return categories

def save_to_csv(categories, filename='mlcaterers_menu.csv'):
    with open(filename, 'w', newline='', encoding='utf-8') as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(['Category', 'Item'])
        
        for category, items in sorted(categories.items()):
            for item in items:
                writer.writerow([category, item])
    
    print(f"Saved {sum(len(items) for items in categories.values())} items across {len(categories)} categories to {filename}")

if __name__ == '__main__':
    categories = parse_menu()
    save_to_csv(categories)